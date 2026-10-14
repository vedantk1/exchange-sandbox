import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RecoveryError } from '../../apps/server/src/errors.js';
import type { AdminResult } from '../../apps/server/src/admin/service.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

describe('faulted session transition recovery', () => {
  let context: ApiFixture | undefined;
  afterEach(async () => context?.dispose());

  it('rolls back a failed second stage and resolves the original operation after inspection restart', async () => {
    let fail = true;
    context = await createApiFixture({
      hooks: {
        beforeRolloverCommit: async () => {
          if (!fail) return;
          fail = false;
          throw new RecoveryError('Injected invariant failure at the real commit boundary.');
        },
      },
    });
    await context.trader('participant');
    const input = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Recover one durable session transition',
    };
    const failed = await context.admin.request('POST', '/api/admin/sessions/rollover', input);
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const gated = await context.sql.query(
      'SELECT rollover_operation_id, active_session_id, fault FROM exchange_control',
    );
    const operationId = gated.rows[0]!.rollover_operation_id as string;
    expect(operationId).toBeTruthy();
    expect(gated.rows[0]!.active_session_id).toBe(context.sessionId);
    expect(gated.rows[0]!.fault).toBeTruthy();
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
        .count,
    ).toBe(1);
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM allocations')).rows[0]!.count,
    ).toBe(1);
    expect(
      (
        await context.sql.query('SELECT count(*)::int AS count FROM receipts WHERE command_id=$1', [
          input.commandId,
        ])
      ).rows[0]!.count,
    ).toBe(0);

    await context.start();
    expect((await context.admin.request('GET', '/health/ready')).statusCode).toBe(503);
    const recovered = await context.admin.request('POST', '/api/admin/sessions/rollover', input);
    expect(recovered.statusCode).toBe(200);
    const result = recovered.json<AdminResult>();
    expect(result).toMatchObject({
      status: 'ACCEPTED',
      data: { previousSessionId: context.sessionId, allocatedAccountCount: 1 },
    });
    expect(
      (await context.admin.request('POST', '/api/admin/sessions/rollover', input)).json(),
    ).toEqual(result);
    const operation = await context.sql.query('SELECT id, state FROM session_rollovers');
    expect(operation.rows).toEqual([{ id: operationId, state: 'COMPLETED' }]);
    const control = await context.sql.query(
      'SELECT active_session_id, market_state, rollover_operation_id, fault FROM exchange_control',
    );
    expect(control.rows[0]).toEqual({
      active_session_id: result.data!.newSessionId,
      market_state: 'PAUSED',
      rollover_operation_id: null,
      fault: null,
    });
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
        .count,
    ).toBe(2);
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM allocations')).rows[0]!.count,
    ).toBe(2);
    expect(context.exchange.getRuntimeFault()).toBeNull();
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    expect((await context.admin.request('GET', '/health/ready')).statusCode).toBe(200);
  });

  it('keeps an unresolved accounting discrepancy gated until the independent evidence is repaired', async () => {
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    context = await createApiFixture({
      hooks: {
        afterRolloverGate: async () => {
          entered();
          await blocked;
        },
      },
    });
    const participant = await context.trader('participant');
    const input = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Require healthy evidence before closing',
    };
    const pending = context.admin.request('POST', '/api/admin/sessions/rollover', input);
    await gate;
    try {
      await context.sql.query(
        "UPDATE balances SET amount=amount+1 WHERE session_id=$1 AND account_id=$2 AND asset='USD-SIM' AND bucket='AVAILABLE'",
        [context.sessionId, participant.user.accountId],
      );
    } finally {
      release();
    }
    expect((await pending).statusCode).toBe(503);
    expect(
      (await context.admin.request('POST', '/api/admin/sessions/rollover', input)).statusCode,
    ).toBe(503);
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
        .count,
    ).toBe(1);
    await context.sql.query(
      "UPDATE balances SET amount=amount-1 WHERE session_id=$1 AND account_id=$2 AND asset='USD-SIM' AND bucket='AVAILABLE'",
      [context.sessionId, participant.user.accountId],
    );
    const recovered = await context.admin.request('POST', '/api/admin/sessions/rollover', input);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: 'ACCEPTED',
      data: { allocatedAccountCount: 1 },
    });
    expect(context.exchange.getRuntimeFault()).toBeNull();
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});
