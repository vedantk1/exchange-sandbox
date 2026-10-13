import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryError } from '../../apps/server/src/errors.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

interface SimulatorRow {
  maker_account_id: string;
  taker_account_id: string;
  enabled: boolean;
  status: string;
  generation: string;
  plan: unknown[];
  next_command: number;
}

describe('audited administrator simulator lifecycle and funding', () => {
  let context: ApiFixture;

  beforeEach(async () => {
    context = await createApiFixture();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  const command = () => ({
    commandId: randomUUID(),
    sessionId: context.sessionId,
    reason: 'Exercise administrator control of the simulated market',
  });

  async function state() {
    return (
      await context.sql.query<SimulatorRow>('SELECT * FROM demo_market WHERE session_id = $1', [
        context.sessionId,
      ])
    ).rows[0];
  }

  async function start() {
    const response = await context.admin.request('POST', '/api/admin/simulator/start', command());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ACCEPTED' });
    return (await state())!;
  }

  async function openOrders(accountId: string) {
    return (
      await context.sql.query<{ id: string }>(
        `SELECT id FROM orders WHERE account_id = $1
          AND status IN ('OPEN', 'PARTIALLY_FILLED') ORDER BY acceptance_sequence`,
        [accountId],
      )
    ).rows;
  }

  async function quote(accountId: string, side: 'BUY' | 'SELL', price: string) {
    const result = await context.exchange.placeLimit({
      accountId,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side,
      price,
      quantity: '0.02',
    });
    expect(result.status).toBe('ACCEPTED');
    return result.order!;
  }

  it('requires administrator authentication, CSRF and a reason before changing simulator intent', async () => {
    const { browser } = await context.trader('participant');
    for (const action of ['start', 'stop']) {
      const path = `/api/admin/simulator/${action}`;
      // Mutation CSRF protection runs before identity lookup for an anonymous request.
      expect((await context.client().request('POST', path, command())).statusCode).toBe(403);
      expect((await browser.request('POST', path, command())).statusCode).toBe(403);
      expect(
        (await context.admin.request('POST', path, command(), { 'x-csrf-token': 'wrong' }))
          .statusCode,
      ).toBe(403);
      expect(
        (await context.admin.request('POST', path, { ...command(), reason: '' })).statusCode,
      ).toBe(400);
    }
    expect(await state()).toBeUndefined();
    expect(
      (
        await context.admin.request('POST', '/api/admin/simulator/start', {
          ...command(),
          sessionId: randomUUID(),
        })
      ).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'STALE_SESSION' });
    expect(await state()).toBeUndefined();
  });

  it('initializes two loginless accounts once while paused and replays starts without issuing funds again', async () => {
    const input = command();
    const first = await context.admin.request('POST', '/api/admin/simulator/start', input);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'ACCEPTED',
      data: { enabled: true, simulatorStatus: 'RUNNING', generation: '1' },
    });
    const initial = (await state())!;
    const ids = [initial.maker_account_id, initial.taker_account_id];
    expect(initial.maker_account_id).not.toBe(initial.taker_account_id);
    expect(
      (await context.sql.query('SELECT * FROM users WHERE account_id = ANY($1::uuid[])', [ids]))
        .rows,
    ).toEqual([]);
    for (const id of ids) {
      const snapshot = await context.exchange.snapshot(id);
      expect(snapshot.balances['BTC-SIM'].total).toBe('1.0000');
      expect(snapshot.balances['USD-SIM'].total).toBe('100000.000000000');
      expect(snapshot.orders).toEqual([]);
    }
    expect((await context.admin.request('GET', '/api/market')).json()).toMatchObject({
      marketState: 'PAUSED',
    });
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/start', input)).json(),
    ).toEqual(first.json());
    await start();
    await context.start();
    await start();
    expect(await state()).toEqual(initial);
    expect((await context.sql.query('SELECT * FROM allocations')).rowCount).toBe(2);
    expect((await context.sql.query('SELECT * FROM journal_transactions')).rowCount).toBe(2);
    expect(
      (
        await context.sql.query('SELECT * FROM admin_audit WHERE command_id = $1', [
          input.commandId,
        ])
      ).rowCount,
    ).toBe(1);
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/stop', input)).statusCode,
    ).toBe(409);
    await context.admin.request('POST', '/api/admin/simulator/stop', command());
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/start', input)).json(),
    ).toEqual(first.json());
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED', generation: '2' });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('stops only simulator orders, releases reservations and preserves inventory across a later start', async () => {
    const human = await context.trader('human_trader');
    const initial = await start();
    await context.marketState('resume');
    const makerOrder = await quote(initial.maker_account_id, 'SELL', '51000');
    const takerOrder = await quote(initial.taker_account_id, 'BUY', '49000');
    const humanOrder = await quote(human.user.accountId, 'BUY', '10000');
    const before = await Promise.all(
      [initial.maker_account_id, initial.taker_account_id].map(async (accountId) => ({
        accountId,
        snapshot: await context.exchange.snapshot(accountId),
      })),
    );
    const input = command();
    const stopped = await context.admin.request('POST', '/api/admin/simulator/stop', input);
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      status: 'ACCEPTED',
      data: { enabled: false, simulatorStatus: 'STOPPED', pendingCancellation: false },
    });
    const canceled = stopped.json<{ data: { canceledOrders: { id: string }[] } }>().data
      .canceledOrders;
    expect(canceled.map((order) => order.id).sort()).toEqual([makerOrder.id, takerOrder.id].sort());
    expect(await openOrders(human.user.accountId)).toEqual([{ id: humanOrder.id }]);
    expect((await context.admin.request('GET', '/api/market')).json()).toMatchObject({
      marketState: 'TRADING',
    });
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/stop', input)).json(),
    ).toEqual(stopped.json());
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED', generation: '2' });
    await context.start();
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED', generation: '2' });
    await start();
    expect(await state()).toMatchObject({
      enabled: true,
      generation: '3',
      maker_account_id: initial.maker_account_id,
      taker_account_id: initial.taker_account_id,
    });
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/stop', input)).json(),
    ).toEqual(stopped.json());
    expect(await state()).toMatchObject({ enabled: true, generation: '3' });
    for (const previous of before) {
      const snapshot = await context.exchange.snapshot(previous.accountId);
      for (const asset of ['BTC-SIM', 'USD-SIM'] as const) {
        expect(snapshot.balances[asset].total).toEqual(previous.snapshot.balances[asset].total);
        expect(Number(snapshot.balances[asset].reserved)).toBe(0);
      }
    }
    expect((await context.sql.query('SELECT * FROM allocations')).rowCount).toBe(3);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('persists stop intent during a financial halt and completes cleanup only after reconciliation', async () => {
    const initial = await start();
    await context.marketState('resume');
    const order = await quote(initial.maker_account_id, 'SELL', '51000');
    await expect(
      context.exchange.financialTransaction(async () => {
        throw new RecoveryError('Injected financial halt before simulator stop');
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    const stopped = await context.admin.request('POST', '/api/admin/simulator/stop', command());
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json()).toMatchObject({
      status: 'ACCEPTED',
      data: {
        enabled: false,
        simulatorStatus: 'STOPPING',
        pendingCancellation: true,
        canceledOrders: [],
      },
    });
    expect(await openOrders(initial.maker_account_id)).toEqual([{ id: order.id }]);
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPING', generation: '2' });
    expect(
      (await context.admin.request('POST', '/api/admin/simulator/start', command())).statusCode,
    ).toBe(503);
    await context.start();
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPING' });
    const resumed = await context.marketState('resume');
    expect(resumed.json()).toMatchObject({
      status: 'ACCEPTED',
      data: { canceledOrders: [{ id: order.id }] },
    });
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED' });
    expect(await openOrders(initial.maker_account_id)).toEqual([]);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('retains disabled intent when cancellation discovers an invariant failure', async () => {
    const initial = await start();
    await context.marketState('resume');
    const order = await quote(initial.maker_account_id, 'SELL', '51000');
    await context.sql.query(`
      CREATE FUNCTION reject_simulator_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected cancellation failure' USING ERRCODE = '23514'; END;
      $$;
      CREATE TRIGGER reject_simulator_cancel BEFORE UPDATE OF status ON orders
      FOR EACH ROW WHEN (NEW.status = 'CANCELED') EXECUTE FUNCTION reject_simulator_cancel();
    `);
    try {
      const stopped = await context.admin.request('POST', '/api/admin/simulator/stop', command());
      expect(stopped.statusCode).toBe(200);
      expect(stopped.json()).toMatchObject({
        status: 'ACCEPTED',
        data: { enabled: false, simulatorStatus: 'STOPPING', pendingCancellation: true },
      });
      expect(await state()).toMatchObject({ enabled: false, status: 'STOPPING' });
      expect(await openOrders(initial.maker_account_id)).toEqual([{ id: order.id }]);
      expect((await context.admin.request('GET', '/api/admin/overview')).json()).toMatchObject({
        marketState: 'PAUSED',
        fault: 'Simulator cancellation requires reconciliation.',
      });
    } finally {
      await context.sql.query('DROP TRIGGER reject_simulator_cancel ON orders');
    }
    expect((await context.marketState('resume')).json()).toMatchObject({ status: 'ACCEPTED' });
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED' });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('funds either registered simulator account with an exact audited grant and no duplicate credit', async () => {
    const initial = await start();
    for (const [accountId, asset, amount, total] of [
      [initial.maker_account_id, 'BTC-SIM', '0.0001', '1.0001'],
      [initial.taker_account_id, 'USD-SIM', '0.000000001', '100000.000000001'],
    ] as const) {
      const input = { ...command(), accountId, asset, amount };
      const granted = await context.admin.request('POST', '/api/admin/grants', input);
      expect(granted.statusCode).toBe(200);
      expect(granted.json()).toMatchObject({ status: 'ACCEPTED' });
      expect((await context.admin.request('POST', '/api/admin/grants', input)).json()).toEqual(
        granted.json(),
      );
      const snapshot = await context.exchange.snapshot(accountId);
      expect(snapshot.balances[asset].total).toBe(total);
      expect(
        (
          await context.sql.query('SELECT * FROM admin_audit WHERE command_id = $1', [
            input.commandId,
          ])
        ).rowCount,
      ).toBe(1);
    }
    expect((await context.sql.query('SELECT * FROM grants')).rowCount).toBe(2);
    expect((await context.sql.query('SELECT * FROM allocations')).rowCount).toBe(2);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    await context.start();
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('rejects grants while trading, halted or targeting an unrelated system account', async () => {
    const initial = await start();
    const input = {
      accountId: initial.maker_account_id,
      asset: 'BTC-SIM',
      amount: '1',
    };
    await context.marketState('resume');
    expect(
      (await context.admin.request('POST', '/api/admin/grants', { ...command(), ...input })).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'MARKET_MUST_BE_PAUSED' });
    await context.marketState('pause');
    const unrelated = randomUUID();
    await context.exchange.createTrader({
      accountId: unrelated,
      commandId: randomUUID(),
      label: 'Unregistered test service account',
    });
    const fee = (
      await context.sql.query<{ id: string }>("SELECT id FROM accounts WHERE kind = 'FEE'")
    ).rows[0]!.id;
    for (const accountId of [unrelated, fee]) {
      expect(
        (
          await context.admin.request('POST', '/api/admin/grants', {
            ...command(),
            ...input,
            accountId,
          })
        ).json(),
      ).toMatchObject({ status: 'REJECTED', code: 'INVALID_TRADER' });
    }
    await expect(
      context.exchange.financialTransaction(async () => {
        throw new RecoveryError('Injected financial halt before grant');
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    expect(
      (await context.admin.request('POST', '/api/admin/grants', { ...command(), ...input }))
        .statusCode,
    ).toBe(503);
    expect((await context.sql.query('SELECT * FROM grants')).rowCount).toBe(0);
  });
});
