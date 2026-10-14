import { randomUUID } from 'node:crypto';
import type { Asset, Database } from '@sandbox/database';
import {
  DomainError,
  formatQuantity,
  formatQuote,
  parseQuantity,
  parseQuote,
} from '@sandbox/domain';
import { sql, type Transaction } from 'kysely';
import { requirePrincipal } from '../auth/index.js';
import { allocateTrader, cancelOrder } from '../core-mutations.js';
import { RecoveryError } from '../errors.js';
import type { Exchange } from '../exchange.js';
import { postJournal } from '../ledger.js';
import { reconcileDatabase } from '../reconcile.js';
import type { OrderView } from '../types.js';
import { requireNoRollover, rolloverSession } from '../session-lifecycle.js';
import {
  fingerprint,
  loadReceipt,
  nextSequence,
  persistAdminResult,
  validateId,
  validateReason,
  type Control,
} from './commands.js';

export interface AdminCommand {
  commandId: string;
  sessionId: string;
  reason: string;
}

export interface AdminResult extends Record<string, unknown> {
  commandId: string;
  sessionId: string;
  sequence: string;
  status: 'ACCEPTED' | 'REJECTED';
  code?: string;
  data?: Record<string, unknown>;
}

type Outcome = Record<string, unknown> & { status: 'ACCEPTED' | 'REJECTED'; code?: string };
type Mode = 'access' | 'financial' | 'recovery';
const rejected = (code: string): Outcome => ({ status: 'REJECTED', code });
const ACTIVE = ['OPEN', 'PARTIALLY_FILLED'] as const;

/** Administrative effects share trading's admission lock, ledger, and durable receipts. */
export class AdminService {
  constructor(private readonly exchange: Exchange) {}

  private async command(
    token: string,
    input: AdminCommand,
    action: string,
    targetId: string | null,
    payload: Record<string, unknown>,
    mode: Mode,
    execute: (tx: Transaction<Database>, control: Control, actorId: string) => Promise<Outcome>,
  ): Promise<AdminResult> {
    validateId(input.commandId);
    validateId(input.sessionId);
    if (targetId !== null) validateId(targetId);
    const reason = validateReason(input.reason);
    const hash = fingerprint({ action, sessionId: input.sessionId, reason, targetId, ...payload });
    const work = async (tx: Transaction<Database>, control: Control): Promise<AdminResult> => {
      const principal = await requirePrincipal(tx, token, 'ADMIN');
      const prior = await loadReceipt(tx, principal.accountId, input.commandId, hash);
      if (prior) return prior as AdminResult;
      if (
        ![
          'TRADER_SUSPENDED',
          'SIMULATOR_STOPPED',
          'MARKET_PAUSED',
          'RECONCILIATION_CHECKED',
        ].includes(action)
      )
        requireNoRollover(control);
      const sequence = await nextSequence(tx, control);
      const outcome =
        control.active_session_id === input.sessionId
          ? await execute(tx, control, principal.accountId)
          : rejected('STALE_SESSION');
      const { status, code, ...data } = outcome;
      const result: AdminResult = {
        commandId: input.commandId,
        sessionId: input.sessionId,
        sequence,
        status,
        ...(code === undefined ? {} : { code }),
        ...(Object.keys(data).length === 0 ? {} : { data }),
      };
      await persistAdminResult(tx, {
        actorId: principal.accountId,
        commandId: input.commandId,
        sessionId: input.sessionId,
        hash,
        sequence,
        action,
        targetId,
        reason,
        result,
      });
      return result;
    };
    if (mode === 'access') return this.exchange.accessTransaction(work);
    if (mode === 'recovery') return this.exchange.recoveryTransaction(work);
    return this.exchange.financialTransaction(work);
  }

  async rollover(token: string, input: AdminCommand): Promise<AdminResult> {
    return rolloverSession(this.exchange, token, input);
  }

  async pause(token: string, input: AdminCommand): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    return this.command(token, input, 'MARKET_PAUSED', null, {}, 'access', async (tx) => {
      await tx
        .updateTable('exchange_control')
        .set({ market_state: 'PAUSED' })
        .where('id', '=', 1)
        .execute();
      return { status: 'ACCEPTED', marketState: 'PAUSED' };
    });
  }

  async resume(token: string, input: AdminCommand): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    let faultRevision: number | undefined;
    let resumed = false;
    const result = await this.command(
      token,
      input,
      'MARKET_RESUMED',
      null,
      {},
      'recovery',
      async (tx) => {
        // Capture after admission: a transaction ahead of this resume may
        // have latched a newer fault while this request waited for the lock.
        faultRevision = this.exchange.getRuntimeFaultRevision();
        const before = await reconcileDatabase(tx);
        if (!before.ok) {
          await tx
            .updateTable('exchange_control')
            .set({ fault: before.issues.join('; '), market_state: 'PAUSED' })
            .where('id', '=', 1)
            .execute();
          return { ...rejected('RECOVERY_REQUIRED'), issues: before.issues };
        }
        const pending = await tx
          .selectFrom('users')
          .select(['account_id', 'suspension_reason'])
          .where('pending_cancellation', '=', true)
          .orderBy('account_id')
          .execute();
        const canceledOrders: OrderView[] = [];
        for (const account of pending) {
          canceledOrders.push(
            ...(await this.cancelAccountOrders(
              tx,
              input.sessionId,
              account.account_id,
              input.commandId,
              `ACCOUNT_SUSPENDED: ${account.suspension_reason ?? 'Access revoked'}`,
            )),
          );
          await tx
            .updateTable('users')
            .set({ pending_cancellation: false, updated_at: new Date() })
            .where('account_id', '=', account.account_id)
            .execute();
        }
        // A stopped simulator may retain quotes while financial mutations are halted.
        // Finish its cleanup under this recovery lock before reopening the market.
        const stoppedSimulator = await tx
          .selectFrom('demo_market')
          .select(['maker_account_id', 'taker_account_id'])
          .where('session_id', '=', input.sessionId)
          .where('enabled', '=', false)
          .executeTakeFirst();
        if (stoppedSimulator) {
          for (const accountId of [
            stoppedSimulator.maker_account_id,
            stoppedSimulator.taker_account_id,
          ]) {
            canceledOrders.push(
              ...(await this.cancelAccountOrders(
                tx,
                input.sessionId,
                accountId,
                input.commandId,
                'DEMO_MARKET_STOPPED',
              )),
            );
          }
          await tx
            .updateTable('demo_market')
            .set({ status: 'STOPPED', plan: '[]', next_command: 0, updated_at: new Date() })
            .where('session_id', '=', input.sessionId)
            .execute();
        }
        const after = await reconcileDatabase(tx);
        if (!after.ok) throw new RecoveryError(after.issues.join('; '));
        await tx
          .updateTable('exchange_control')
          .set({ fault: null, market_state: 'TRADING' })
          .where('id', '=', 1)
          .execute();
        resumed = true;
        return {
          status: 'ACCEPTED',
          marketState: 'TRADING',
          canceledOrders,
          completedSuspensions: pending.map((account) => account.account_id),
        };
      },
    );
    // A replayed historical resume must never clear a newer fault.
    if (resumed && faultRevision !== undefined) this.exchange.clearRuntimeFault(faultRevision);
    return result;
  }

  async cancelOrder(
    token: string,
    input: AdminCommand & { orderId: string },
  ): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    validateId(input.orderId);
    return this.command(
      token,
      input,
      'ORDER_CANCELED_BY_ADMIN',
      input.orderId,
      {},
      'financial',
      async (tx) => {
        const order = await cancelOrder(tx, {
          sessionId: input.sessionId,
          orderId: input.orderId,
          commandId: input.commandId,
          reason: `ADMIN_REQUEST: ${input.reason}`,
        });
        return order ? { status: 'ACCEPTED', order } : rejected('ORDER_NOT_FOUND');
      },
    );
  }

  async startSimulator(token: string, input: AdminCommand): Promise<AdminResult> {
    return this.command(token, input, 'SIMULATOR_STARTED', null, {}, 'financial', async (tx) => {
      let state = await tx
        .selectFrom('demo_market')
        .selectAll()
        .where('session_id', '=', input.sessionId)
        .executeTakeFirst();
      if (state?.status === 'STOPPING') return rejected('PENDING_CANCELLATION');
      if (!state) {
        const maker = randomUUID();
        const taker = randomUUID();
        for (const [id, label] of [
          [maker, 'Demo market maker'],
          [taker, 'Demo market taker'],
        ] as const) {
          await tx.insertInto('accounts').values({ id, kind: 'TRADER', label }).execute();
          await allocateTrader(tx, input.sessionId, id, input.commandId);
        }
        state = await tx
          .insertInto('demo_market')
          .values({
            session_id: input.sessionId,
            maker_account_id: maker,
            taker_account_id: taker,
            enabled: true,
            status: 'RUNNING',
            generation: '1',
            plan: '[]',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      } else if (!state.enabled) {
        state = await tx
          .updateTable('demo_market')
          .set({
            enabled: true,
            status: 'RUNNING',
            generation: (BigInt(state.generation) + 1n).toString(),
            plan: '[]',
            next_command: 0,
            updated_at: new Date(),
          })
          .where('session_id', '=', input.sessionId)
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      return {
        status: 'ACCEPTED',
        enabled: true,
        simulatorStatus: state.status,
        makerAccountId: state.maker_account_id,
        takerAccountId: state.taker_account_id,
        generation: state.generation,
      };
    });
  }

  async stopSimulator(token: string, input: AdminCommand): Promise<AdminResult> {
    return this.command(
      token,
      input,
      'SIMULATOR_STOPPED',
      null,
      {},
      'recovery',
      async (tx, control) => {
        const state = await tx
          .selectFrom('demo_market')
          .selectAll()
          .where('session_id', '=', input.sessionId)
          .executeTakeFirst();
        if (!state || (!state.enabled && state.status === 'STOPPED')) {
          return {
            status: 'ACCEPTED',
            enabled: false,
            simulatorStatus: 'STOPPED',
            pendingCancellation: false,
            canceledOrders: [],
          };
        }
        // Persist disabled intent before any financial cleanup. The generation
        // fences work already dispatched by the scheduler, even after a restart.
        await tx
          .updateTable('demo_market')
          .set({
            enabled: false,
            status: 'STOPPING',
            generation: (BigInt(state.generation) + 1n).toString(),
            plan: '[]',
            next_command: 0,
            updated_at: new Date(),
          })
          .where('session_id', '=', input.sessionId)
          .execute();
        let pendingCancellation = true;
        let canceledOrders: OrderView[] = [];
        if (!control.fault && !control.rollover_operation_id) {
          await sql`SAVEPOINT simulator_cancellations`.execute(tx);
          try {
            for (const accountId of [state.maker_account_id, state.taker_account_id]) {
              canceledOrders.push(
                ...(await this.cancelAccountOrders(
                  tx,
                  input.sessionId,
                  accountId,
                  input.commandId,
                  'DEMO_MARKET_STOPPED',
                )),
              );
            }
            await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
            await tx
              .updateTable('demo_market')
              .set({ status: 'STOPPED' })
              .where('session_id', '=', input.sessionId)
              .execute();
            pendingCancellation = false;
          } catch (error) {
            if (!(error instanceof RecoveryError) && (error as { code?: string })?.code !== '23514')
              throw error;
            await sql`ROLLBACK TO SAVEPOINT simulator_cancellations`.execute(tx);
            await tx
              .updateTable('exchange_control')
              .set({
                fault: 'Simulator cancellation requires reconciliation.',
                market_state: 'PAUSED',
              })
              .where('id', '=', 1)
              .execute();
            canceledOrders = [];
          }
        }
        return {
          status: 'ACCEPTED',
          enabled: false,
          simulatorStatus: pendingCancellation ? 'STOPPING' : 'STOPPED',
          pendingCancellation,
          canceledOrders,
        };
      },
    );
  }

  async grant(
    token: string,
    input: AdminCommand & {
      accountId: string;
      asset: Asset;
      amount: string;
    },
  ): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    if (input.asset !== 'BTC-SIM' && input.asset !== 'USD-SIM')
      throw new DomainError('INVALID_ASSET', 'Choose BTC-SIM or USD-SIM.');
    const amount =
      input.asset === 'BTC-SIM' ? parseQuantity(input.amount) : parseQuote(input.amount);
    if (amount <= 0n || (input.asset === 'USD-SIM' && amount > 10_000_000_000_000_000n))
      throw new DomainError(
        'INVALID_GRANT',
        'Grants must be positive and within the per-grant limit.',
      );
    const amountText = (input.asset === 'BTC-SIM' ? formatQuantity : formatQuote)(amount);
    return this.command(
      token,
      input,
      'FUNDS_GRANTED',
      input.accountId,
      { asset: input.asset, amount: amountText },
      'financial',
      async (tx, control, actorId) => {
        if (control.market_state !== 'PAUSED') return rejected('MARKET_MUST_BE_PAUSED');
        const target = await tx
          .selectFrom('accounts')
          .leftJoin('users', 'users.account_id', 'accounts.id')
          .select(['accounts.kind', 'users.role', 'users.status'])
          .where('accounts.id', '=', input.accountId)
          .executeTakeFirst();
        if (target?.kind !== 'TRADER') return rejected('INVALID_TRADER');
        if (target.role === 'TRADER') {
          if (target.status !== 'ACTIVE') return rejected('ACCOUNT_SUSPENDED');
        } else {
          const simulator = await tx
            .selectFrom('demo_market')
            .select('session_id')
            .where('session_id', '=', input.sessionId)
            .where((eb) =>
              eb.or([
                eb('maker_account_id', '=', input.accountId),
                eb('taker_account_id', '=', input.accountId),
              ]),
            )
            .executeTakeFirst();
          if (!simulator) return rejected('INVALID_TRADER');
        }
        const issuance = await tx
          .selectFrom('accounts')
          .select('id')
          .where('kind', '=', 'ISSUANCE')
          .executeTakeFirstOrThrow();
        const id = randomUUID();
        await tx
          .insertInto('grants')
          .values({
            id,
            session_id: input.sessionId,
            account_id: input.accountId,
            actor_id: actorId,
            command_id: input.commandId,
            asset: input.asset,
            amount: amount.toString(),
            reason: input.reason,
          })
          .execute();
        await postJournal(tx, input.sessionId, input.commandId, 'GRANT', [
          { accountId: input.accountId, asset: input.asset, bucket: 'AVAILABLE', amount },
          { accountId: issuance.id, asset: input.asset, bucket: 'AVAILABLE', amount: -amount },
        ]);
        return {
          status: 'ACCEPTED',
          grant: { id, accountId: input.accountId, asset: input.asset, amount: amountText },
        };
      },
    );
  }

  async suspend(token: string, input: AdminCommand & { accountId: string }): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    return this.command(
      token,
      input,
      'TRADER_SUSPENDED',
      input.accountId,
      {},
      'recovery',
      async (tx, control) => {
        const target = await tx
          .selectFrom('users')
          .select('role')
          .where('account_id', '=', input.accountId)
          .executeTakeFirst();
        if (target?.role !== 'TRADER') return rejected('INVALID_TRADER');
        await tx
          .updateTable('users')
          .set({
            status: 'SUSPENDED',
            suspension_reason: input.reason,
            pending_cancellation: true,
            updated_at: new Date(),
          })
          .where('account_id', '=', input.accountId)
          .execute();
        await tx
          .updateTable('login_sessions')
          .set({ revoked_at: new Date() })
          .where('account_id', '=', input.accountId)
          .where('revoked_at', 'is', null)
          .execute();
        await tx
          .updateTable('recovery_tokens')
          .set({ revoked_at: new Date() })
          .where('account_id', '=', input.accountId)
          .where('revoked_at', 'is', null)
          .where('used_at', 'is', null)
          .execute();
        let pendingCancellation = true;
        let canceledOrders: OrderView[] = [];
        if (!control.fault && !control.rollover_operation_id) {
          // Restrictions survive a newly discovered financial failure: only the
          // cancellation work sits behind this inner savepoint.
          await sql`SAVEPOINT suspension_cancellations`.execute(tx);
          try {
            canceledOrders = await this.cancelAccountOrders(
              tx,
              input.sessionId,
              input.accountId,
              input.commandId,
              `ACCOUNT_SUSPENDED: ${input.reason}`,
            );
            await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
            await tx
              .updateTable('users')
              .set({ pending_cancellation: false })
              .where('account_id', '=', input.accountId)
              .execute();
            pendingCancellation = false;
          } catch (error) {
            if (!(error instanceof RecoveryError) && (error as { code?: string })?.code !== '23514')
              throw error;
            await sql`ROLLBACK TO SAVEPOINT suspension_cancellations`.execute(tx);
            await tx
              .updateTable('exchange_control')
              .set({
                fault: 'Suspension cancellation requires reconciliation.',
                market_state: 'PAUSED',
              })
              .where('id', '=', 1)
              .execute();
            canceledOrders = [];
          }
        }
        return {
          status: 'ACCEPTED',
          accountId: input.accountId,
          accountStatus: 'SUSPENDED',
          pendingCancellation,
          canceledOrders,
        };
      },
    );
  }

  async reinstate(
    token: string,
    input: AdminCommand & { accountId: string },
  ): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    return this.command(
      token,
      input,
      'TRADER_REINSTATED',
      input.accountId,
      {},
      'financial',
      async (tx) => {
        const target = await tx
          .selectFrom('users')
          .select(['role', 'pending_cancellation'])
          .where('account_id', '=', input.accountId)
          .executeTakeFirst();
        if (target?.role !== 'TRADER') return rejected('INVALID_TRADER');
        if (target.pending_cancellation) return rejected('PENDING_CANCELLATION');
        await allocateTrader(tx, input.sessionId, input.accountId, input.commandId);
        await tx
          .updateTable('users')
          .set({ status: 'ACTIVE', suspension_reason: null, updated_at: new Date() })
          .where('account_id', '=', input.accountId)
          .execute();
        return { status: 'ACCEPTED', accountId: input.accountId, accountStatus: 'ACTIVE' };
      },
    );
  }

  async reconcile(token: string, input: AdminCommand): Promise<AdminResult> {
    input = { ...input, reason: validateReason(input.reason) };
    return this.command(token, input, 'RECONCILIATION_CHECKED', null, {}, 'access', async (tx) => {
      const report = await reconcileDatabase(tx);
      if (!report.ok)
        await tx
          .updateTable('exchange_control')
          .set({ fault: report.issues.join('; '), market_state: 'PAUSED' })
          .where('id', '=', 1)
          .execute();
      return { status: 'ACCEPTED', ...report };
    });
  }

  private async cancelAccountOrders(
    tx: Transaction<Database>,
    sessionId: string,
    accountId: string,
    commandId: string,
    reason: string,
  ): Promise<OrderView[]> {
    const orders = await tx
      .selectFrom('orders')
      .select('id')
      .where('session_id', '=', sessionId)
      .where('account_id', '=', accountId)
      .where('status', 'in', ACTIVE)
      .orderBy('acceptance_sequence')
      .execute();
    const canceled: OrderView[] = [];
    for (const order of orders) {
      const result = await cancelOrder(tx, { sessionId, orderId: order.id, commandId, reason });
      if (result) canceled.push(result);
    }
    return canceled;
  }

  async overview(token: string): Promise<Record<string, unknown>> {
    return this.exchange.accessTransaction(async (tx, control) => {
      await requirePrincipal(tx, token, 'ADMIN');
      const counts = await sql<{
        traders: string;
        suspended: string;
        pending: string;
        open_orders: string;
      }>`select (select count(*)::text from users where role = 'TRADER') as traders,
          (select count(*)::text from users where status = 'SUSPENDED') as suspended,
          (select count(*)::text from users where pending_cancellation) as pending,
          (select count(*)::text from orders where session_id = ${control.active_session_id}::uuid
            and status in ('OPEN', 'PARTIALLY_FILLED')) as open_orders`.execute(tx);
      return {
        sessionId: control.active_session_id,
        marketState: control.market_state,
        fault: control.fault,
        counts: counts.rows[0],
      };
    });
  }

  async listTraders(token: string): Promise<Record<string, unknown>[]> {
    return this.exchange.readTransaction(async (tx) => {
      await requirePrincipal(tx, token, 'ADMIN');
      const rows = await tx
        .selectFrom('users')
        .select([
          'account_id',
          'handle',
          'status',
          'suspension_reason',
          'pending_cancellation',
          'created_at',
        ])
        .where('role', '=', 'TRADER')
        .orderBy('handle')
        .limit(200)
        .execute();
      return rows.map((row) => ({
        accountId: row.account_id,
        handle: row.handle,
        status: row.status,
        suspensionReason: row.suspension_reason,
        pendingCancellation: row.pending_cancellation,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async listAudits(token: string): Promise<Record<string, unknown>[]> {
    return this.exchange.readTransaction(async (tx) => {
      await requirePrincipal(tx, token, 'ADMIN');
      const rows = await tx
        .selectFrom('admin_audit')
        .selectAll()
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(100)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        commandId: row.command_id,
        sessionId: row.session_id,
        action: row.action,
        targetId: row.target_id,
        reason: row.reason,
        result: row.result,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }
}
