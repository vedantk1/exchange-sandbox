import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult } from '../../apps/server/src/types.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';
import { killAtTransactionBoundary } from '../helpers/crash.js';

describe('protected market execution against PostgreSQL', () => {
  let context: TestExchange;
  let maker: string;
  let trader: string;

  beforeEach(async () => {
    context = await createTestExchange();
    maker = await context.trader('maker');
    trader = await context.trader('trader');
  });

  afterEach(async () => context?.dispose());

  async function preview(side: 'BUY' | 'SELL' = 'BUY', quantity = '0.2') {
    return context.exchange.previewMarket({
      accountId: trader,
      sessionId: context.sessionId,
      side,
      quantity,
    });
  }

  function command(previewId: string) {
    return { accountId: trader, sessionId: context.sessionId, commandId: randomUUID(), previewId };
  }

  it.each([
    ['BUY', 'SELL', '50000.01', '52500.01'],
    ['SELL', 'BUY', '50000.01', '47500.01'],
  ] as const)(
    'rounds the %s guard inward at 5%% and previews without reserving funds',
    async (side, opposite, price, guard) => {
      await context.place(maker, opposite, '0.2', price);
      const before = await context.exchange.snapshot(trader);
      const countsBefore = await context.sql.query('SELECT count(*) AS count FROM journal_entries');
      const quote = await preview(side);
      expect(quote).toMatchObject({
        side,
        quantity: '0.2000',
        referencePrice: price,
        guardPrice: guard,
        estimatedFilledQuantity: '0.2000',
        estimatedRemainingQuantity: '0.0000',
        estimatedNotional: '10000.002000000',
        estimatedFee: '10.000002000',
        estimatedAveragePrice: `${price}0000000`,
        estimatedCancelReason: null,
      });
      expect(Date.parse(quote.expiresAt) - Date.parse(quote.createdAt)).toBe(10_000);
      expect(await context.exchange.snapshot(trader)).toEqual(before);
      expect(
        (await context.sql.query('SELECT count(*) AS count FROM journal_entries')).rows,
      ).toEqual(countsBefore.rows);
      const result = await context.exchange.placeMarket(command(quote.previewId));
      expect(result.order).toMatchObject({
        type: 'MARKET',
        price: guard,
        status: 'FILLED',
        remaining: '0.0000',
      });
      expect(result.fills[0]).toMatchObject({
        price,
        quantity: '0.2000',
        notional: '10000.002000000',
      });
      expect((await context.exchange.reconcile()).ok).toBe(true);
    },
  );

  it('releases the full buy guard reservation, price improvement and canceled remainder exactly', async () => {
    await context.place(maker, 'SELL', '0.1', '50000');
    const quote = await preview();
    expect(quote.reservation).toEqual({ asset: 'USD-SIM', amount: '10510.500000000' });
    expect(quote.estimatedCancelReason).toBe('INSUFFICIENT_LIQUIDITY');
    const result = await context.exchange.placeMarket(command(quote.previewId));
    expect(result.order).toMatchObject({
      type: 'MARKET',
      status: 'CANCELED',
      remaining: '0.1000',
      reserved: '0.000000000',
      cancelReason: 'INSUFFICIENT_LIQUIDITY',
    });
    expect(result.fills).toHaveLength(1);
    expect((await context.exchange.snapshot(trader)).balances).toEqual({
      'BTC-SIM': { available: '1.1000', reserved: '0.0000', total: '1.1000' },
      'USD-SIM': {
        available: '94995.000000000',
        reserved: '0.000000000',
        total: '94995.000000000',
      },
    });
    expect((await context.exchange.snapshot(context.feeAccountId)).balances['USD-SIM'].total).toBe(
      '10.000000000',
    );
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it.each([
    ['BUY', 'SELL', '52500', '52500.01'],
    ['SELL', 'BUY', '47500', '47499.99'],
  ] as const)(
    'fills %s at the confirmed boundary and never one tick beyond it',
    async (side, opposite, boundary, outside) => {
      await context.place(maker, opposite, '0.1', '50000');
      await context.place(maker, opposite, '0.1', boundary);
      const protectedOrder = await context.place(maker, opposite, '0.1', outside);
      const quote = await preview(side, '0.3');
      expect(quote).toMatchObject({
        estimatedFilledQuantity: '0.2000',
        estimatedRemainingQuantity: '0.1000',
        estimatedCancelReason: 'PRICE_GUARD_REACHED',
      });
      const result = await context.exchange.placeMarket(command(quote.previewId));
      expect(result.fills.map((fill) => fill.price)).toEqual(['50000.00', `${boundary}.00`]);
      expect(result.order).toMatchObject({
        status: 'CANCELED',
        remaining: '0.1000',
        cancelReason: 'PRICE_GUARD_REACHED',
      });
      expect(
        (await context.exchange.snapshot(maker)).orders.find(
          (order) => order.id === protectedOrder.order!.id,
        ),
      ).toMatchObject({ status: 'OPEN', remaining: '0.1000' });
      expect((await context.exchange.reconcile()).ok).toBe(true);
    },
  );

  it.each(['NO_LIQUIDITY', 'PRICE_GUARD_REACHED'] as const)(
    'records a zero-fill terminal order when the preview book changes to %s',
    async (reason) => {
      const ask = await context.place(maker, 'SELL', '0.2', '50000');
      const quote = await preview();
      await context.cancel(maker, ask.order!.id);
      if (reason === 'PRICE_GUARD_REACHED') await context.place(maker, 'SELL', '0.2', '53000');
      const before = (await context.exchange.snapshot(trader)).balances;
      const result = await context.exchange.placeMarket(command(quote.previewId));
      expect(result).toMatchObject({
        status: 'ACCEPTED',
        fills: [],
        order: {
          type: 'MARKET',
          status: 'CANCELED',
          remaining: '0.2000',
          reserved: '0.000000000',
          cancelReason: reason,
        },
      });
      expect((await context.exchange.snapshot(trader)).balances).toEqual(before);
      expect((await context.exchange.reconcile()).ok).toBe(true);
    },
  );

  it('keeps earlier executions and stops at the first self order without skipping it', async () => {
    const first = await context.place(maker, 'SELL', '0.1', '50000');
    const own = await context.place(trader, 'SELL', '0.1', '50010');
    const beyond = await context.place(maker, 'SELL', '0.1', '50020');
    const quote = await preview('BUY', '0.3');
    expect(quote).toMatchObject({
      estimatedFilledQuantity: '0.1000',
      estimatedRemainingQuantity: '0.2000',
      estimatedCancelReason: 'SELF_TRADE_PREVENTION',
    });
    const result = await context.exchange.placeMarket(command(quote.previewId));
    expect(result.fills.map((fill) => fill.makerOrderId)).toEqual([first.order!.id]);
    expect(result.order).toMatchObject({
      status: 'CANCELED',
      remaining: '0.2000',
      cancelReason: 'SELF_TRADE_PREVENTION',
      reserved: '0.000000000',
    });
    expect(
      (await context.exchange.snapshot(trader)).orders.find((order) => order.id === own.order!.id),
    ).toMatchObject({ status: 'OPEN', reserved: '0.1000' });
    expect(
      (await context.exchange.snapshot(maker)).orders.find(
        (order) => order.id === beyond.order!.id,
      ),
    ).toMatchObject({ status: 'OPEN' });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('requires full worst-case funds even when the current shallow book would be affordable', async () => {
    await context.place(maker, 'SELL', '0.1', '50000');
    const quote = await preview('BUY', '2');
    expect(quote.reservation.amount).toBe('105105.000000000');
    const before = await context.exchange.snapshot(trader);
    const submission = command(quote.previewId);
    const result = await context.exchange.placeMarket(submission);
    expect(result).toMatchObject({ status: 'REJECTED', code: 'INSUFFICIENT_FUNDS', fills: [] });
    expect(await context.exchange.placeMarket(submission)).toEqual(result);
    expect(await context.exchange.placeMarket(command(quote.previewId))).toMatchObject({
      status: 'REJECTED',
      code: 'PREVIEW_USED',
    });
    expect(await context.exchange.snapshot(trader)).toEqual(before);
  });

  it('rechecks available inventory at confirmation after another order reserves it', async () => {
    await context.place(maker, 'BUY', '0.9', '50000');
    const quote = await preview('SELL', '0.9');
    await context.place(trader, 'SELL', '0.2', '60000');
    const before = await context.exchange.snapshot(trader);
    expect(await context.exchange.placeMarket(command(quote.previewId))).toMatchObject({
      status: 'REJECTED',
      code: 'INSUFFICIENT_FUNDS',
    });
    expect(await context.exchange.snapshot(trader)).toEqual(before);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('allows only one execution when different command identities race for the same preview', async () => {
    await context.place(maker, 'SELL', '0.4', '50000');
    const quote = await preview();
    const results = await Promise.all([
      context.exchange.placeMarket(command(quote.previewId)),
      context.exchange.placeMarket(command(quote.previewId)),
    ]);
    expect(results.filter((result) => result.status === 'ACCEPTED')).toHaveLength(1);
    expect(results.filter((result) => result.code === 'PREVIEW_USED')).toHaveLength(1);
    expect((await context.exchange.snapshot(trader)).orders).toHaveLength(1);
    expect((await context.exchange.snapshot(trader)).fills).toHaveLength(1);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('rejects an empty preview book and malformed or too-small quantities without financial mutation', async () => {
    await expect(preview()).rejects.toMatchObject({ code: 'NO_LIQUIDITY' });
    await context.place(maker, 'SELL', '0.1', '100');
    await expect(preview('BUY', '0.0001')).rejects.toMatchObject({ code: 'ORDER_TOO_SMALL' });
    await expect(preview('BUY', '0.10000')).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    expect((await context.exchange.snapshot(trader)).orders).toHaveLength(0);
  });

  it('permits an immediate market order at the 50 resting-order cap', async () => {
    for (let index = 0; index < 50; index++) {
      expect((await context.place(trader, 'BUY', '0.001', '10000')).status).toBe('ACCEPTED');
    }
    await context.place(maker, 'SELL', '0.1', '50000');
    const quote = await preview('BUY', '0.1');
    expect((await context.exchange.placeMarket(command(quote.previewId))).order?.status).toBe(
      'FILLED',
    );
    expect(
      (await context.exchange.snapshot(trader)).orders.filter((order) => order.status === 'OPEN'),
    ).toHaveLength(50);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('enforces immutable preview terms and prevents a persisted market order from resting', async () => {
    await context.place(maker, 'SELL', '0.3', '50000');
    const quote = await preview();
    await expect(
      context.sql.query('UPDATE market_previews SET guard_price = guard_price + 1 WHERE id = $1', [
        quote.previewId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      context.sql.query('DELETE FROM market_previews WHERE id = $1', [quote.previewId]),
    ).rejects.toMatchObject({ code: '23514' });
    const result = await context.exchange.placeMarket(command(quote.previewId));
    expect(result.order?.status).toBe('FILLED');
    await expect(
      context.sql.query('DELETE FROM market_preview_uses WHERE preview_id = $1', [quote.previewId]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      context.sql.query(
        "UPDATE orders SET status = 'OPEN', remaining_quantity = quantity, reserved_amount = quantity * price * 1001 WHERE id = $1",
        [result.order!.id],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'market_orders_never_rest' });
    expect((await context.exchange.snapshot(trader)).orders[0]).toMatchObject({
      type: 'MARKET',
      status: 'FILLED',
      remaining: '0.0000',
      reserved: '0.000000000',
    });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('makes concurrent retries identical, binds a preview once, and survives reopening', async () => {
    await context.place(maker, 'SELL', '0.3', '50000');
    const quote = await preview('BUY', '0.1');
    const submission = command(quote.previewId);
    const [first, retry] = await Promise.all([
      context.exchange.placeMarket(submission),
      context.exchange.placeMarket(submission),
    ]);
    expect(first.status).toBe('ACCEPTED');
    expect(retry).toEqual(first);
    expect(await context.exchange.placeMarket(command(quote.previewId))).toMatchObject({
      status: 'REJECTED',
      code: 'PREVIEW_USED',
    });
    const other = await preview('BUY', '0.1');
    await expect(
      context.exchange.placeMarket({ ...submission, previewId: other.previewId }),
    ).rejects.toMatchObject({ code: 'COMMAND_CONFLICT' });
    await context.start();
    expect(await context.exchange.placeMarket(submission)).toEqual(first);
    expect((await context.exchange.snapshot(trader)).fills).toHaveLength(1);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });
});

describe('protected market admission through HTTP', () => {
  let context: ApiFixture;
  beforeEach(async () => {
    context = await createApiFixture();
  });
  afterEach(async () => context?.dispose());

  async function participants() {
    const maker = await context.trader('maker');
    const taker = await context.trader('taker');
    await context.marketState('resume');
    await maker.browser.request('POST', '/api/orders', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.4',
      price: '50000',
    });
    const body = { sessionId: context.sessionId, side: 'BUY', quantity: '0.1' };
    const response = await taker.browser.request('POST', '/api/orders/market/preview', body);
    expect(response.statusCode).toBe(200);
    const quote = response.json<{ previewId: string; expiresAt: string }>();
    const submission = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      previewId: quote.previewId,
    };
    return { maker, taker, body, quote, submission };
  }

  it('protects preview ownership and immutable terms at the authenticated boundary', async () => {
    const { maker, taker, body, quote, submission } = await participants();
    expect(
      (
        await maker.browser.request('POST', '/api/orders/market', {
          ...submission,
          commandId: randomUUID(),
        })
      ).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'PREVIEW_NOT_FOUND' });
    expect(
      (
        await taker.browser.request('POST', '/api/orders/market', {
          ...submission,
          guardPrice: '99999',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await taker.browser.request('POST', '/api/orders/market/preview', {
          ...body,
          accountId: maker.user.accountId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await taker.browser.request('POST', '/api/orders/market/preview', body, {
          'x-csrf-token': '',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await context.admin.request('POST', '/api/orders/market/preview', body)).statusCode,
    ).toBe(403);
    expect(
      (
        await context.client().request('POST', '/api/orders/market/preview', body, {
          cookie: 'sandbox_csrf=unauthenticated-csrf',
          'x-csrf-token': 'unauthenticated-csrf',
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await taker.browser.request('POST', '/api/orders/market', {
          ...submission,
          commandId: randomUUID(),
          sessionId: randomUUID(),
        })
      ).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'STALE_SESSION' });
    const placed = (
      await taker.browser.request('POST', '/api/orders/market', submission)
    ).json<CommandResult>();
    expect(placed).toMatchObject({
      status: 'ACCEPTED',
      order: { type: 'MARKET', status: 'FILLED' },
    });
    expect(JSON.stringify(placed.fills)).not.toContain(maker.user.accountId);
    expect(
      (await maker.browser.request('GET', `/api/receipts/${submission.commandId}`)).json(),
    ).toBeNull();
    expect(
      (await taker.browser.request('GET', `/api/receipts/${submission.commandId}`)).json(),
    ).toEqual(placed);
    expect(quote.previewId).toBeTruthy();
  });

  it('uses database wall time after lock acquisition to reject a queued expired preview', async () => {
    const { taker, quote, submission } = await participants();
    const before = await context.exchange.snapshot(taker.user.accountId);
    // Enter the lock queue shortly before expiry: the ordinary 2-second lock bound remains intact.
    await context.sql.query(
      'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())) - 1.25))',
      [quote.expiresAt],
    );
    const locker = await context.sql.connect();
    let pending: ReturnType<typeof taker.browser.request> | undefined;
    try {
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM exchange_control FOR UPDATE');
      pending = taker.browser.request('POST', '/api/orders/market', submission);
      await locker.query(
        'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.05)',
        [quote.expiresAt],
      );
      await locker.query('COMMIT');
      expect((await pending).json()).toMatchObject({ status: 'REJECTED', code: 'PREVIEW_EXPIRED' });
    } finally {
      await locker.query('ROLLBACK');
      locker.release();
      await pending;
    }
    expect(await context.exchange.snapshot(taker.user.accountId)).toEqual(before);
    expect(
      (await taker.browser.request('POST', '/api/orders/market', submission)).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'PREVIEW_EXPIRED' });
  });

  it('blocks preview and confirmation while the exchange is faulted without consuming the preview', async () => {
    const { taker, body, submission } = await participants();
    const before = await context.exchange.snapshot(taker.user.accountId);
    // Model an already persisted operational halt, without corrupting the financial ledger.
    await context.sql.query(
      "UPDATE exchange_control SET fault = 'Test recovery gate', market_state = 'PAUSED' WHERE id = 1",
    );
    for (const [path, payload] of [
      ['/api/orders/market/preview', body],
      ['/api/orders/market', submission],
    ] as const) {
      const response = await taker.browser.request('POST', path, payload);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    }
    expect(await context.exchange.snapshot(taker.user.accountId)).toEqual(before);
    expect(
      (await context.sql.query('SELECT count(*) AS count FROM market_preview_uses')).rows,
    ).toEqual([{ count: '0' }]);
  });

  it('rechecks pause and credential revocation before executing a valid preview', async () => {
    const { taker, submission, body } = await participants();
    await context.marketState('pause');
    expect(
      (await taker.browser.request('POST', '/api/orders/market', submission)).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'MARKET_PAUSED' });
    expect(
      (await taker.browser.request('POST', '/api/orders/market/preview', body)).json(),
    ).toMatchObject({ code: 'MARKET_PAUSED' });
    await context.marketState('resume');
    const revokedCookies = taker.browser.cookieHeader;
    const revokedCsrf = taker.browser.csrfToken;
    expect((await taker.browser.request('POST', '/api/auth/logout', {})).statusCode).toBe(200);
    expect(
      (
        await taker.browser.request(
          'POST',
          '/api/orders/market',
          {
            ...submission,
            commandId: randomUUID(),
          },
          { cookie: revokedCookies, 'x-csrf-token': revokedCsrf },
        )
      ).statusCode,
    ).toBe(401);
    expect((await context.exchange.snapshot(taker.user.accountId)).orders).toHaveLength(0);
  });
});

describe('protected market process-loss recovery', () => {
  let context: TestExchange;
  beforeEach(async () => {
    context = await createTestExchange();
  });
  afterEach(async () => context?.dispose());

  it.each(['beforeCommit', 'afterCommit'] as const)(
    'recovers a partial market fill after SIGKILL at %s',
    async (stage) => {
      const maker = await context.trader('maker');
      const trader = await context.trader('trader');
      await context.place(maker, 'SELL', '0.1', '50000');
      const quote = await context.exchange.previewMarket({
        accountId: trader,
        sessionId: context.sessionId,
        side: 'BUY',
        quantity: '0.2',
      });
      const submission = {
        accountId: trader,
        sessionId: context.sessionId,
        commandId: randomUUID(),
        previewId: quote.previewId,
      };
      const before = await context.exchange.snapshot(trader);
      await context.stop();
      await killAtTransactionBoundary(context.url, stage, submission, 'market');
      await context.start();
      const recovered = await context.exchange.getReceipt(trader, submission.commandId);
      if (stage === 'beforeCommit') {
        expect(recovered).toBeNull();
        expect(await context.exchange.snapshot(trader)).toEqual(before);
      } else {
        expect(recovered).toMatchObject({
          status: 'ACCEPTED',
          order: { status: 'CANCELED', remaining: '0.1000' },
        });
        // Receipt replay remains valid after the preview itself can no longer authorize a new execution.
        await context.sql.query(
          'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.05)',
          [quote.expiresAt],
        );
      }
      const resolved = await context.exchange.placeMarket(submission);
      expect(resolved).toMatchObject({
        status: 'ACCEPTED',
        order: { status: 'CANCELED', remaining: '0.1000', reserved: '0.000000000' },
      });
      if (stage === 'afterCommit') expect(resolved).toEqual(recovered);
      const counts = async () =>
        (
          await context.sql.query(
            'SELECT (SELECT count(*) FROM fills) AS fills, (SELECT count(*) FROM journal_entries) AS entries, (SELECT count(*) FROM receipts) AS receipts, (SELECT count(*) FROM outbox) AS events',
          )
        ).rows;
      const persisted = await counts();
      expect(await context.exchange.placeMarket(submission)).toEqual(resolved);
      expect(await counts()).toEqual(persisted);
      const snapshot = await context.exchange.snapshot(trader);
      expect(snapshot.orders).toHaveLength(1);
      expect(snapshot.fills).toHaveLength(1);
      expect(snapshot.balances['USD-SIM']).toEqual({
        available: '94995.000000000',
        reserved: '0.000000000',
        total: '94995.000000000',
      });
      expect(
        (await context.exchange.snapshot(context.feeAccountId)).balances['USD-SIM'].total,
      ).toBe('10.000000000');
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    },
  );
});
