import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DemoMarket } from '../../apps/server/src/demo-market/service.js';
import { RecoveryError } from '../../apps/server/src/errors.js';
import type { CommandResult } from '../../apps/server/src/types.js';
import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

interface SimulatorRow {
  maker_account_id: string;
  taker_account_id: string;
  enabled: boolean;
  status: string;
  cycle: string;
  plan: unknown[];
  next_command: number;
}

describe('durable development market simulator', () => {
  let context: ApiFixture;
  let simulator: DemoMarket;
  let afterCommit: ((commandId: string) => Promise<void>) | undefined;

  beforeEach(async () => {
    afterCommit = undefined;
    context = await createApiFixture({
      hooks: { afterCommit: async (commandId) => afterCommit?.(commandId) },
    });
    simulator = new DemoMarket(context.exchange);
  });

  afterEach(async () => {
    afterCommit = undefined;
    await context?.dispose();
  });

  async function state() {
    return (
      await context.sql.query<SimulatorRow>('SELECT * FROM demo_market WHERE session_id = $1', [
        context.sessionId,
      ])
    ).rows[0];
  }

  async function botIds() {
    const row = (await state())!;
    return [row.maker_account_id, row.taker_account_id];
  }

  async function counts() {
    return (
      await context.sql.query<{
        orders: number;
        fills: number;
        allocations: number;
        journals: number;
      }>(`
        SELECT (SELECT count(*)::integer FROM orders) AS orders,
          (SELECT count(*)::integer FROM fills) AS fills,
          (SELECT count(*)::integer FROM allocations) AS allocations,
          (SELECT count(*)::integer FROM journal_transactions) AS journals
      `)
    ).rows[0]!;
  }

  async function botOpenOrders() {
    return (
      await context.sql.query<{ id: string; account_id: string }>(
        `SELECT id, account_id FROM orders WHERE account_id = ANY($1::uuid[])
          AND status IN ('OPEN', 'PARTIALLY_FILLED') ORDER BY acceptance_sequence`,
        [await botIds()],
      )
    ).rows;
  }

  async function receipt(commandId: string) {
    return (
      await context.sql.query<{ result: CommandResult }>(
        'SELECT result FROM receipts WHERE command_id = $1',
        [commandId],
      )
    ).rows[0]?.result;
  }

  async function resume() {
    expect((await context.marketState('resume')).json()).toMatchObject({ status: 'ACCEPTED' });
  }

  it('creates bounded real orders, fills, fees and candles through ordinary accounting', async () => {
    const before = (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
    await resume();
    for (let index = 0; index < 8; index += 1) {
      await simulator.tick();
      expect((await botOpenOrders()).length).toBeLessThanOrEqual(5);
    }

    const ids = await botIds();
    expect((await counts()).allocations).toBe(2);
    expect(
      (
        await context.sql.query('SELECT account_id FROM users WHERE account_id = ANY($1::uuid[])', [
          ids,
        ])
      ).rows,
    ).toEqual([]);
    const workspace = (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(workspace.market.trades.length).toBeGreaterThanOrEqual(8);
    expect(workspace.market.candles.length).toBeGreaterThan(0);
    expect(new Set(workspace.market.trades.map((trade) => trade.price)).size).toBeGreaterThan(1);
    expect(BigInt(workspace.cursor)).toBeGreaterThan(BigInt(before.cursor));
    const fees = (
      await context.sql.query<{ charged: string; accrued: string }>(`
        SELECT (SELECT sum(buyer_fee + seller_fee)::text FROM fills) AS charged,
          (SELECT sum(amount)::text FROM balances JOIN accounts ON accounts.id = account_id
            WHERE kind = 'FEE' AND asset = 'USD-SIM') AS accrued
      `)
    ).rows[0]!;
    expect(BigInt(fees.charged)).toBeGreaterThan(0n);
    expect(fees.accrued).toBe(fees.charged);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('respects initial and later administrator pauses without allocating or trading ahead', async () => {
    await simulator.tick();
    expect(await state()).toBeUndefined();
    expect(await counts()).toEqual({ orders: 0, fills: 0, allocations: 0, journals: 0 });
    await resume();
    await simulator.tick();
    expect((await counts()).fills).toBeGreaterThan(0);
    expect((await context.marketState('pause')).json()).toMatchObject({ status: 'ACCEPTED' });
    const paused = await counts();
    const orders = await botOpenOrders();
    await simulator.tick();
    await simulator.tick();
    expect(await counts()).toEqual(paused);
    expect(await botOpenOrders()).toEqual(orders);
    await resume();
    await simulator.tick();
    expect((await counts()).fills).toBeGreaterThan(paused.fills);
    expect((await counts()).allocations).toBe(2);
  });

  it('replays an acknowledged-lost fill after restart without duplicate trades or allocations', async () => {
    await resume();
    let interruptedCommand = '';
    let committed: CommandResult | undefined;
    afterCommit = async (commandId) => {
      const result = await receipt(commandId);
      if (!result?.fills?.length) return;
      interruptedCommand = commandId;
      committed = result;
      afterCommit = undefined;
      throw new Error('Injected lost simulator acknowledgement after commit');
    };
    await expect(simulator.tick()).rejects.toThrow('Injected lost simulator acknowledgement');
    expect(interruptedCommand).not.toBe('');
    const pending = (await state())!;
    expect(pending.next_command).toBeLessThan(pending.plan.length);
    const before = await counts();
    await context.start();
    simulator = new DemoMarket(context.exchange);
    await simulator.tick();
    expect(await receipt(interruptedCommand)).toEqual(committed);
    expect((await counts()).orders).toBe(before.orders);
    expect((await counts()).fills).toBe(before.fills);
    expect((await counts()).allocations).toBe(2);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    await simulator.tick();
    expect((await counts()).fills).toBeGreaterThan(before.fills);
  });

  it('discards unfinished placements on disabled restart and cancels only simulator orders', async () => {
    const trader = await context.trader('human_trader');
    await resume();
    const humanOrder = await context.exchange.placeLimit({
      accountId: trader.user.accountId,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY',
      quantity: '0.01',
      price: '10000',
    });
    afterCommit = async (commandId) => {
      if (!(await receipt(commandId))?.order) return;
      afterCommit = undefined;
      throw new Error('Injected loss after first simulator placement');
    };
    await expect(simulator.tick()).rejects.toThrow('Injected loss after first simulator placement');
    const before = await counts();
    expect((await botOpenOrders()).length).toBeGreaterThan(0);
    await context.start();
    simulator = new DemoMarket(context.exchange);
    await simulator.stop();
    expect(await botOpenOrders()).toEqual([]);
    expect((await counts()).orders).toBe(before.orders);
    expect((await counts()).fills).toBe(before.fills);
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED', plan: [] });
    expect((await context.exchange.snapshot(trader.user.accountId)).orders).toContainEqual(
      humanOrder.order,
    );
    for (const accountId of await botIds()) {
      const snapshot = await context.exchange.snapshot(accountId);
      expect(snapshot.balances['BTC-SIM'].reserved).toBe('0.0000');
      expect(snapshot.balances['USD-SIM'].reserved).toBe('0.000000000');
    }
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('does not bypass a financial halt to trade or claim that quote cleanup succeeded', async () => {
    await resume();
    await simulator.tick();
    const open = await botOpenOrders();
    expect(open).toHaveLength(4);
    await expect(
      context.exchange.financialTransaction(async () => {
        throw new RecoveryError('Injected financial halt during simulator operation');
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    const halted = await counts();
    await simulator.tick();
    await simulator.stop();
    expect(await counts()).toEqual(halted);
    expect(await botOpenOrders()).toEqual(open);
    expect(await state()).toMatchObject({ enabled: false, status: 'ERROR' });
    const resumed = (await context.marketState('resume')).json<{
      status: string;
      data: { canceledOrders: { id: string; cancelReason: string }[] };
    }>();
    expect(resumed.status).toBe('ACCEPTED');
    expect(resumed.data.canceledOrders.map((order) => order.id).sort()).toEqual(
      open.map((order) => order.id).sort(),
    );
    expect(
      resumed.data.canceledOrders.every((order) => order.cancelReason === 'DEMO_MARKET_STOPPED'),
    ).toBe(true);
    expect(await botOpenOrders()).toEqual([]);
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED' });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('reduces activity when participants consume inventory without minting replacement funds', async () => {
    const trader = await context.trader('inventory_taker');
    await resume();
    await simulator.tick();
    const ids = await botIds();
    for (const order of await botOpenOrders()) {
      await context.exchange.cancel({
        accountId: order.account_id,
        commandId: randomUUID(),
        sessionId: context.sessionId,
        orderId: order.id,
      });
    }
    // Consume both finite BTC inventories through valid orders and balanced journals.
    await context.exchange.placeLimit({
      accountId: trader.user.accountId,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY',
      quantity: '2',
      price: '100',
    });
    for (const accountId of ids) {
      const quantity = (await context.exchange.snapshot(accountId)).balances['BTC-SIM'].available;
      const sale = await context.exchange.placeLimit({
        accountId,
        commandId: randomUUID(),
        sessionId: context.sessionId,
        side: 'SELL',
        quantity,
        price: '100',
      });
      expect(sale.order?.status).toBe('FILLED');
      expect((await context.exchange.snapshot(accountId)).balances['BTC-SIM'].total).toBe('0.0000');
    }
    const depleted = await counts();
    await simulator.tick();
    await simulator.tick();
    expect(await state()).toMatchObject({ status: 'LIMITED_INVENTORY' });
    expect((await counts()).fills).toBe(depleted.fills);
    expect((await counts()).allocations).toBe(depleted.allocations);
    for (const accountId of ids) {
      expect((await context.exchange.snapshot(accountId)).balances['BTC-SIM'].total).toBe('0.0000');
    }
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('drains an in-flight dispatch before stopping and releases every remaining reservation', async () => {
    await resume();
    let entered!: () => void;
    let release!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    afterCommit = async (commandId) => {
      if (!(await receipt(commandId))?.order) return;
      afterCommit = undefined;
      entered();
      await proceed;
    };
    const tick = simulator.tick();
    let stopping: Promise<void> | undefined;
    try {
      await dispatched;
      stopping = simulator.stop();
    } finally {
      release();
      await Promise.all([tick, ...(stopping ? [stopping] : [])]);
    }
    expect(await botOpenOrders()).toEqual([]);
    expect(await state()).toMatchObject({ enabled: false, status: 'STOPPED', plan: [] });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});
