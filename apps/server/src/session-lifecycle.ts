import { randomUUID } from 'node:crypto';
import type { Database } from '@sandbox/database';
import { sql, type Selectable, type Transaction } from 'kysely';
import { requirePrincipal } from './auth/access.js';
import { AuthError } from './auth/errors.js';
import {
  appendAudit,
  fingerprint,
  loadReceipt,
  nextSequence,
  persistAdminResult,
  validateId,
  validateReason,
} from './admin/commands.js';
import type { AdminCommand, AdminResult } from './admin/service.js';
import { allocateTrader, cancelOrder } from './core-mutations.js';
import { CommandConflictError, RecoveryError } from './errors.js';
import type { Control, Exchange } from './exchange.js';
import { reconcileDatabase } from './reconcile.js';

type Operation = Selectable<Database['session_rollovers']>;
const ACTION = 'SESSION_ROLLED_OVER';

/** A temporary gate never consumes an invitation or writes a financial command receipt. */
export function requireNoRollover(control: Control): void {
  if (control.rollover_operation_id)
    throw new AuthError(
      'SESSION_ROLLING_OVER',
      'A new session is being prepared. Resolve pending commands and retry after it completes.',
      503,
    );
}

async function rejection(
  tx: Transaction<Database>,
  control: Control,
  input: AdminCommand,
  actorId: string,
  hash: string,
  code: string,
): Promise<AdminResult> {
  const sequence = await nextSequence(tx, control);
  const result: AdminResult = {
    commandId: input.commandId,
    sessionId: input.sessionId,
    sequence,
    status: 'REJECTED',
    code,
  };
  await persistAdminResult(tx, {
    actorId,
    commandId: input.commandId,
    sessionId: input.sessionId,
    hash,
    sequence,
    action: ACTION,
    targetId: null,
    reason: input.reason,
    result,
  });
  return result;
}

/** First commit publishes the durable gate; the second commits the complete financial transition. */
export async function rolloverSession(
  exchange: Exchange,
  token: string,
  input: AdminCommand,
): Promise<AdminResult> {
  input = { ...input, reason: validateReason(input.reason) };
  validateId(input.commandId);
  validateId(input.sessionId);
  const hash = fingerprint({
    action: ACTION,
    sessionId: input.sessionId,
    reason: input.reason,
    targetId: null,
  });
  const staged = await exchange.accessTransaction(async (tx, control) => {
    const actor = await requirePrincipal(tx, token, 'ADMIN');
    const prior = await loadReceipt(tx, actor.accountId, input.commandId, hash);
    if (prior) return { result: prior as AdminResult };
    const operation = await tx
      .selectFrom('session_rollovers')
      .selectAll()
      .where('actor_id', '=', actor.accountId)
      .where('command_id', '=', input.commandId)
      .executeTakeFirst();
    if (operation) {
      if (operation.payload_hash !== hash) throw new CommandConflictError();
      if (operation.id !== control.rollover_operation_id || operation.state !== 'IN_PROGRESS')
        throw new RecoveryError('The session operation has no matching recovery gate.');
      return { operationId: operation.id, created: false };
    }
    requireNoRollover(control);
    if (control.active_session_id !== input.sessionId)
      return {
        result: await rejection(tx, control, input, actor.accountId, hash, 'STALE_SESSION'),
      };
    if (control.fault)
      return {
        result: await rejection(tx, control, input, actor.accountId, hash, 'RECOVERY_REQUIRED'),
      };
    if (control.market_state !== 'PAUSED')
      return {
        result: await rejection(tx, control, input, actor.accountId, hash, 'MARKET_MUST_BE_PAUSED'),
      };
    const report = await reconcileDatabase(tx);
    if (!report.ok) {
      await tx
        .updateTable('exchange_control')
        .set({ fault: report.issues.join('; '), market_state: 'PAUSED' })
        .where('id', '=', 1)
        .execute();
      return {
        result: await rejection(tx, control, input, actor.accountId, hash, 'RECOVERY_REQUIRED'),
      };
    }
    const id = randomUUID();
    const newSessionId = randomUUID();
    await tx
      .insertInto('session_rollovers')
      .values({
        id,
        actor_id: actor.accountId,
        command_id: input.commandId,
        previous_session_id: input.sessionId,
        new_session_id: newSessionId,
        payload_hash: hash,
        reason: input.reason,
        state: 'IN_PROGRESS',
        completed_at: null,
      })
      .execute();
    await tx
      .updateTable('exchange_control')
      .set({ rollover_operation_id: id, market_state: 'PAUSED' })
      .where('id', '=', 1)
      .execute();
    const simulator = await tx
      .selectFrom('demo_market')
      .select('generation')
      .where('session_id', '=', input.sessionId)
      .executeTakeFirst();
    if (simulator) {
      await tx
        .updateTable('demo_market')
        .set({
          enabled: false,
          status: 'STOPPING',
          generation: (BigInt(simulator.generation) + 1n).toString(),
          plan: '[]',
          next_command: 0,
          updated_at: new Date(),
        })
        .where('session_id', '=', input.sessionId)
        .execute();
    }
    const sequence = await nextSequence(tx, control);
    const transition = {
      operationId: id,
      previousSessionId: input.sessionId,
      newSessionId,
      state: 'IN_PROGRESS',
    };
    await appendAudit(tx, {
      actorId: actor.accountId,
      commandId: input.commandId,
      sessionId: input.sessionId,
      action: 'SESSION_ROLLOVER_STARTED',
      targetId: id,
      reason: input.reason,
      result: transition,
    });
    await tx
      .insertInto('outbox')
      .values({
        session_id: input.sessionId,
        sequence,
        event_type: 'SESSION_ROLLOVER_STARTED',
        payload: transition,
      })
      .execute();
    return { operationId: id, created: true };
  });
  if ('result' in staged && staged.result) return staged.result;
  if (!staged.operationId) throw new RecoveryError('Missing session operation identity.');
  if (staged.created) await exchange.rolloverBoundary('afterGate', input.commandId);
  return completeRollover(exchange, staged.operationId);
}

/** The previously authorized operation survives lost sessions, process crashes, and HTTP replies. */
export async function recoverSessionRollover(exchange: Exchange): Promise<void> {
  const operationId = await exchange.readTransaction(async (tx) => {
    const control = await tx
      .selectFrom('exchange_control')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    return control.rollover_operation_id;
  });
  if (operationId) await completeRollover(exchange, operationId);
}

async function completeRollover(exchange: Exchange, operationId: string): Promise<AdminResult> {
  let completed = false;
  let commandId = '';
  let faultRevision: number | undefined;
  const result = await exchange.recoveryTransaction(async (tx, control) => {
    const operation: Operation = await tx
      .selectFrom('session_rollovers')
      .selectAll()
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    commandId = operation.command_id;
    const prior = await loadReceipt(tx, operation.actor_id, commandId, operation.payload_hash);
    if (prior) return prior as AdminResult;
    if (
      control.rollover_operation_id !== operation.id ||
      control.active_session_id !== operation.previous_session_id ||
      control.market_state !== 'PAUSED' ||
      operation.state !== 'IN_PROGRESS'
    )
      throw new RecoveryError('The durable session gate does not match the pending operation.');
    const before = await reconcileDatabase(tx);
    if (!before.ok) throw new RecoveryError(before.issues.join('; '));
    // A failed second stage retains its original gate and fault. The same
    // authorized operation can proceed only after independent reconciliation
    // confirms that the repaired projections and evidence are healthy.
    faultRevision = exchange.getRuntimeFaultRevision();
    const simulator = await tx
      .selectFrom('demo_market')
      .selectAll()
      .where('session_id', '=', operation.previous_session_id)
      .executeTakeFirst();
    const open = await tx
      .selectFrom('orders')
      .select('id')
      .where('session_id', '=', operation.previous_session_id)
      .where('status', 'in', ['OPEN', 'PARTIALLY_FILLED'])
      .orderBy('acceptance_sequence')
      .execute();
    for (const order of open)
      await cancelOrder(tx, {
        sessionId: operation.previous_session_id,
        orderId: order.id,
        commandId,
        reason: 'SESSION_ENDED',
      });
    if (simulator) {
      await tx
        .updateTable('demo_market')
        .set({
          enabled: false,
          status: 'STOPPED',
          plan: '[]',
          next_command: 0,
          updated_at: new Date(),
        })
        .where('session_id', '=', operation.previous_session_id)
        .execute();
    }
    await tx
      .updateTable('users')
      .set({ pending_cancellation: false })
      .where('pending_cancellation', '=', true)
      .execute();
    await tx
      .updateTable('exchange_sessions')
      // Both sides share this transaction timestamp; archived metadata must
      // not suggest that two sessions overlapped while cancellation ran.
      .set({ state: 'CLOSED', closed_at: sql<Date>`CURRENT_TIMESTAMP` })
      .where('id', '=', operation.previous_session_id)
      .execute();
    await tx
      .insertInto('exchange_sessions')
      .values({ id: operation.new_session_id, state: 'ACTIVE' })
      .execute();
    const participants = await tx
      .selectFrom('accounts')
      .leftJoin('users', 'users.account_id', 'accounts.id')
      .select('accounts.id')
      .where('accounts.kind', '=', 'TRADER')
      .where((eb) =>
        eb.or([
          eb.and([eb('users.role', '=', 'TRADER'), eb('users.status', '=', 'ACTIVE')]),
          // Preserve trusted core/demo participants created before invitation enrollment.
          eb.and([
            eb('users.account_id', 'is', null),
            eb.exists(
              eb
                .selectFrom('allocations')
                .select('account_id')
                .whereRef('allocations.account_id', '=', 'accounts.id')
                .where('allocations.session_id', '=', operation.previous_session_id),
            ),
          ]),
        ]),
      )
      .orderBy('accounts.id')
      .execute();
    const accountIds = new Set(participants.map((account) => account.id));
    if (simulator) {
      accountIds.add(simulator.maker_account_id);
      accountIds.add(simulator.taker_account_id);
      await tx
        .insertInto('demo_market')
        .values({
          session_id: operation.new_session_id,
          maker_account_id: simulator.maker_account_id,
          taker_account_id: simulator.taker_account_id,
          enabled: false,
          status: 'STOPPED',
          generation: (BigInt(simulator.generation) + 1n).toString(),
          plan: '[]',
        })
        .execute();
    }
    for (const accountId of accountIds)
      await allocateTrader(tx, operation.new_session_id, accountId, commandId);
    await tx
      .updateTable('exchange_control')
      .set({
        active_session_id: operation.new_session_id,
        market_state: 'PAUSED',
        rollover_operation_id: null,
        fault: null,
      })
      .where('id', '=', 1)
      .execute();
    await tx
      .updateTable('session_rollovers')
      .set({ state: 'COMPLETED', completed_at: sql<Date>`clock_timestamp()` })
      .where('id', '=', operation.id)
      .execute();
    const sequence = await nextSequence(tx, control);
    const data = {
      previousSessionId: operation.previous_session_id,
      newSessionId: operation.new_session_id,
      canceledOrderCount: open.length,
      allocatedAccountCount: accountIds.size,
    };
    const result: AdminResult = {
      commandId,
      sessionId: operation.previous_session_id,
      sequence,
      status: 'ACCEPTED',
      data,
    };
    await persistAdminResult(tx, {
      actorId: operation.actor_id,
      commandId,
      sessionId: operation.previous_session_id,
      hash: operation.payload_hash,
      sequence,
      action: ACTION,
      targetId: null,
      reason: operation.reason,
      result,
    });
    await tx
      .insertInto('outbox')
      .values({
        session_id: operation.new_session_id,
        sequence,
        event_type: 'SESSION_CHANGED',
        payload: data,
      })
      .execute();
    const after = await reconcileDatabase(tx);
    if (!after.ok) throw new RecoveryError(after.issues.join('; '));
    await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
    await exchange.rolloverBoundary('beforeCommit', commandId);
    completed = true;
    return result;
  });
  if (completed) {
    if (faultRevision !== undefined) exchange.clearRuntimeFault(faultRevision);
    await exchange.rolloverBoundary('afterCommit', commandId);
  }
  return result;
}
