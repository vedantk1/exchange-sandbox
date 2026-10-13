import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

describe('transactional exchange against PostgreSQL', () => {
  let context: TestExchange;

  beforeEach(async () => {
    context = await createTestExchange();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  it('issues starting funds once even when trader creation is retried with a new command identity', async () => {
    const input = { accountId: randomUUID(), label: 'trader', commandId: randomUUID() };
    const created = await context.exchange.createTrader(input);
    const before = await context.exchange.snapshot(input.accountId);
    const journalBefore = await context.sql.query('SELECT count(*) AS count FROM journal_entries');
    expect(await context.exchange.createTrader(input)).toEqual(created);
    expect(await context.exchange.createTrader({ ...input, commandId: randomUUID() })).toEqual(
      created,
    );
    expect(await context.exchange.snapshot(input.accountId)).toEqual(before);
    expect(before.balances['BTC-SIM'].total).toBe('1.0000');
    expect(before.balances['USD-SIM'].total).toBe('100000.000000000');
    expect((await context.sql.query('SELECT count(*) AS count FROM journal_entries')).rows).toEqual(
      journalBefore.rows,
    );
    const allocation = await context.sql.query(
      'SELECT count(*) AS count FROM allocations WHERE account_id = $1',
      [input.accountId],
    );
    expect(allocation.rows).toEqual([{ count: '1' }]);
    await expect(
      context.exchange.createTrader({ ...input, label: 'changed' }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('rejects malformed exact-number inputs before persisting any command effects', async () => {
    const trader = await context.trader('trader');
    const before = await context.exchange.snapshot(trader);
    const command = {
      accountId: trader,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY' as const,
      quantity: '0.10000',
      price: '50000',
    };
    const countsBefore = await context.sql.query(`
      SELECT (SELECT count(*) FROM receipts) AS receipts,
        (SELECT count(*) FROM journal_entries) AS entries,
        (SELECT count(*) FROM outbox) AS outbox
    `);
    await expect(context.exchange.placeLimit(command)).rejects.toMatchObject({
      code: 'INVALID_QUANTITY',
    });
    await expect(
      context.exchange.placeLimit({ ...command, quantity: 0.1 as unknown as string }),
    ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    await expect(
      context.exchange.placeLimit({ ...command, quantity: '0.1', price: '50000.001' }),
    ).rejects.toMatchObject({ code: 'INVALID_PRICE' });
    await expect(
      context.exchange.placeLimit({ ...command, accountId: `${trader}\n`, quantity: '0.1' }),
    ).rejects.toMatchObject({ code: 'INVALID_ID' });
    expect(await context.exchange.getReceipt(trader, command.commandId)).toBeNull();
    expect(await context.exchange.snapshot(trader)).toEqual(before);
    const countsAfter = await context.sql.query(`
      SELECT (SELECT count(*) FROM receipts) AS receipts,
        (SELECT count(*) FROM journal_entries) AS entries,
        (SELECT count(*) FROM outbox) AS outbox
    `);
    expect(countsAfter.rows).toEqual(countsBefore.rows);
  });

  it('completes the accepted partial-fill and cancellation example with exact fees', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    const ask = await context.place(seller, 'SELL', '0.4', '50000');
    expect(ask.status).toBe('ACCEPTED');
    expect(ask.order).toMatchObject({ status: 'OPEN', remaining: '0.4000', reserved: '0.4000' });

    const bid = await context.place(buyer, 'BUY', '0.1', '50000');
    expect(bid.order).toMatchObject({
      status: 'FILLED',
      remaining: '0.0000',
      reserved: '0.000000000',
    });
    expect(bid.fills).toHaveLength(1);
    expect(bid.fills[0]).toMatchObject({
      makerOrderId: ask.order!.id,
      quantity: '0.1000',
      price: '50000.00',
      notional: '5000.000000000',
      buyerFee: '5.000000000',
      sellerFee: '5.000000000',
    });
    expect((await context.exchange.snapshot(seller)).orders[0]).toMatchObject({
      status: 'PARTIALLY_FILLED',
      remaining: '0.3000',
      reserved: '0.3000',
    });

    const canceled = await context.cancel(seller, ask.order!.id);
    expect(canceled.order).toMatchObject({
      status: 'CANCELED',
      remaining: '0.3000',
      reserved: '0.0000',
    });
    const sellerSnapshot = await context.exchange.snapshot(seller);
    const buyerSnapshot = await context.exchange.snapshot(buyer);
    expect(sellerSnapshot.balances).toEqual({
      'BTC-SIM': { available: '0.9000', reserved: '0.0000', total: '0.9000' },
      'USD-SIM': {
        available: '104995.000000000',
        reserved: '0.000000000',
        total: '104995.000000000',
      },
    });
    expect(buyerSnapshot.balances).toEqual({
      'BTC-SIM': { available: '1.1000', reserved: '0.0000', total: '1.1000' },
      'USD-SIM': {
        available: '94995.000000000',
        reserved: '0.000000000',
        total: '94995.000000000',
      },
    });
    const fees = await context.exchange.snapshot(context.feeAccountId);
    expect(fees.balances['USD-SIM'].total).toBe('10.000000000');
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });

    // A fresh command canceling the same terminal order cannot release twice.
    await context.cancel(seller, ask.order!.id);
    expect((await context.exchange.snapshot(seller)).balances).toEqual(sellerSnapshot.balances);
  });

  it('releases price improvement immediately and reserves only the unfilled commitment', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.place(seller, 'SELL', '0.1', '49900');
    const bid = await context.place(buyer, 'BUY', '0.2', '50000');
    expect(bid.order).toMatchObject({
      status: 'PARTIALLY_FILLED',
      remaining: '0.1000',
      reserved: '5005.000000000',
    });
    expect((await context.exchange.snapshot(buyer)).balances['USD-SIM']).toEqual({
      available: '90000.010000000',
      reserved: '5005.000000000',
      total: '95005.010000000',
    });
    await context.cancel(buyer, bid.order!.id);
    expect((await context.exchange.snapshot(buyer)).balances['USD-SIM']).toEqual({
      available: '95005.010000000',
      reserved: '0.000000000',
      total: '95005.010000000',
    });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('matches best price, then acceptance order, at each resting order price', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    const worse = await context.place(seller, 'SELL', '0.1', '50010');
    const first = await context.place(seller, 'SELL', '0.1', '50000');
    const second = await context.place(seller, 'SELL', '0.1', '50000');
    const bid = await context.place(buyer, 'BUY', '0.25', '50100');

    expect(bid.fills.map((fill) => [fill.makerOrderId, fill.quantity, fill.price])).toEqual([
      [first.order!.id, '0.1000', '50000.00'],
      [second.order!.id, '0.1000', '50000.00'],
      [worse.order!.id, '0.0500', '50010.00'],
    ]);
    expect(bid.fills.map((fill) => fill.fillIndex)).toEqual([0, 1, 2]);
    expect((await context.exchange.snapshot(buyer)).fills).toEqual(bid.fills);
    await context.start();
    expect((await context.exchange.snapshot(buyer)).fills).toEqual(bid.fills);
    expect((await context.exchange.snapshot(buyer)).balances['USD-SIM'].total).toBe(
      '87486.999500000',
    );
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('preserves earlier fills and cancels an incoming remainder when it meets its own order', async () => {
    const trader = await context.trader('trader');
    const other = await context.trader('other');
    const better = await context.place(other, 'SELL', '0.1', '49000');
    const own = await context.place(trader, 'SELL', '0.1', '50000');
    const worse = await context.place(other, 'SELL', '0.1', '51000');
    const incoming = await context.place(trader, 'BUY', '0.3', '52000');

    expect(incoming.order).toMatchObject({
      status: 'CANCELED',
      remaining: '0.2000',
      reserved: '0.000000000',
    });
    expect(incoming.fills).toHaveLength(1);
    expect(incoming.fills[0]!.makerOrderId).toBe(better.order!.id);
    expect(
      (await context.exchange.snapshot(trader)).orders.find((order) => order.id === own.order!.id),
    ).toMatchObject({ status: 'OPEN', remaining: '0.1000', reserved: '0.1000' });
    expect(
      (await context.exchange.snapshot(other)).orders.find((order) => order.id === worse.order!.id),
    ).toMatchObject({ status: 'OPEN', remaining: '0.1000' });
    expect((await context.exchange.snapshot(trader)).balances['USD-SIM'].total).toBe(
      '95095.100000000',
    );
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('prevents concurrent orders from spending the same available funds', async () => {
    const buyer = await context.trader('buyer');
    const results = await Promise.all([
      context.place(buyer, 'BUY', '1', '60000'),
      context.place(buyer, 'BUY', '1', '60000'),
    ]);
    expect(results.filter((result) => result.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'REJECTED')).toHaveLength(1);
    expect(results.find((result) => result.status === 'REJECTED')!.code).toBe('INSUFFICIENT_FUNDS');
    expect((await context.exchange.snapshot(buyer)).balances['USD-SIM']).toEqual({
      available: '39940.000000000',
      reserved: '60060.000000000',
      total: '100000.000000000',
    });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('makes concurrent duplicate commands idempotent and rejects a changed payload', async () => {
    const buyer = await context.trader('buyer');
    const command = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    const [first, duplicate] = await Promise.all([
      context.exchange.placeLimit(command),
      context.exchange.placeLimit(command),
    ]);
    expect(duplicate).toEqual(first);
    expect((await context.exchange.snapshot(buyer)).orders).toHaveLength(1);
    await expect(context.exchange.placeLimit({ ...command, price: '49900' })).rejects.toMatchObject(
      { code: 'COMMAND_CONFLICT' },
    );

    const seller = await context.trader('seller');
    await context.place(seller, 'SELL', '0.1', '50000');
    expect((await context.exchange.snapshot(buyer)).orders[0]!.status).toBe('FILLED');
    // The receipt describes the original acknowledgement, not current order state.
    expect(await context.exchange.placeLimit(command)).toEqual(first);
    expect(await context.exchange.getReceipt(buyer, command.commandId)).toEqual(first);
  });

  it('durably records business rejection without a reservation and denies cross-account cancellation', async () => {
    const seller = await context.trader('seller');
    const other = await context.trader('other');
    const command = {
      accountId: seller,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL' as const,
      quantity: '2',
      price: '50000',
    };
    const rejected = await context.exchange.placeLimit(command);
    expect(rejected).toMatchObject({ status: 'REJECTED', code: 'INSUFFICIENT_FUNDS' });
    expect(await context.exchange.placeLimit(command)).toEqual(rejected);
    expect((await context.exchange.snapshot(seller)).balances['BTC-SIM'].reserved).toBe('0.0000');

    const order = await context.place(seller, 'SELL', '0.4', '50000');
    const denied = await context.cancel(other, order.order!.id);
    expect(denied).toMatchObject({ status: 'REJECTED', code: 'NOT_ORDER_OWNER' });
    expect(
      (await context.exchange.snapshot(seller)).orders.find((item) => item.id === order.order!.id),
    ).toMatchObject({ status: 'OPEN', reserved: '0.4000' });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('serializes a cancellation racing a fill without double release or lost fills', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    const ask = await context.place(seller, 'SELL', '0.4', '50000');
    await Promise.all([
      context.cancel(seller, ask.order!.id),
      context.place(buyer, 'BUY', '0.1', '50000'),
    ]);
    const sold = await context.exchange.snapshot(seller);
    const bought = await context.exchange.snapshot(buyer);
    expect(sold.orders[0]).toMatchObject({ status: 'CANCELED', reserved: '0.0000' });
    expect(['0.3000', '0.4000']).toContain(sold.orders[0]!.remaining);
    if (sold.fills.length === 1) {
      expect(bought.orders[0]!.status).toBe('FILLED');
      expect(sold.balances['BTC-SIM'].total).toBe('0.9000');
      expect(bought.balances['USD-SIM'].total).toBe('94995.000000000');
    } else {
      expect(sold.fills).toHaveLength(0);
      expect(bought.orders[0]).toMatchObject({ status: 'OPEN', reserved: '5005.000000000' });
      expect(sold.balances['BTC-SIM'].total).toBe('1.0000');
    }
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('recovers committed orders and keeps their acceptance priority after reopening', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    const first = await context.place(seller, 'SELL', '0.1', '50000');
    const second = await context.place(seller, 'SELL', '0.1', '50000');
    const before = await context.exchange.snapshot(seller);
    await context.start();
    expect(await context.exchange.snapshot(seller)).toEqual(before);
    const result = await context.place(buyer, 'BUY', '0.15', '50000');
    expect(result.fills.map((fill) => fill.makerOrderId)).toEqual([
      first.order!.id,
      second.order!.id,
    ]);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });
});
