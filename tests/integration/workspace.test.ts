import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  WorkspaceView,
  AccountView,
  OrderDetailResponse,
} from '../../packages/contracts/src/index.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

describe('consistent trader and administrator workspaces', () => {
  let context: ApiFixture;
  beforeEach(async () => {
    context = await createApiFixture();
  });
  afterEach(async () => {
    await context?.dispose();
  });
  const command = (sessionId: string, side: 'BUY' | 'SELL', quantity: string, price = '50000') => ({
    commandId: randomUUID(),
    sessionId,
    side,
    quantity,
    price,
  });

  it('explains partial fills, cancellation, rejected commands and exact account activity without counterparties', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.marketState('resume');
    const ask = (
      await seller.browser.request('POST', '/api/orders', command(context.sessionId, 'SELL', '0.4'))
    ).json<{ order: { id: string } }>().order;
    const bid = (
      await buyer.browser.request(
        'POST',
        '/api/orders',
        command(context.sessionId, 'BUY', '0.1', '51000'),
      )
    ).json<{ order: { id: string } }>().order;
    const before = (await seller.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(before.account?.openOrders[0]).toMatchObject({
      id: ask.id,
      status: 'PARTIALLY_FILLED',
      executedQuantity: '0.1000',
      averagePrice: '50000.000000000',
      cumulativeFee: '5.000000000',
    });
    expect(before.account?.balances['USD-SIM'].total).toBe('104995.000000000');
    expect(before.market.candles).toEqual([
      {
        timestamp: expect.any(String),
        open: '50000.00',
        high: '50000.00',
        low: '50000.00',
        close: '50000.00',
        volume: '0.1000',
      },
    ]);
    expect(before.account?.fills[0]).toMatchObject({
      orderId: ask.id,
      role: 'MAKER',
      side: 'SELL',
      fee: '5.000000000',
    });
    expect(before.account?.activity.some((entry) => entry.commandId === null)).toBe(true);
    expect(before.admin).toBeUndefined();
    expect(JSON.stringify(before)).not.toContain(buyer.user.accountId);
    expect(JSON.stringify(before)).not.toContain(bid.id);
    const detail = (
      await seller.browser.request('GET', `/api/orders/${ask.id}`)
    ).json<OrderDetailResponse>();
    expect(detail.order).toEqual(before.account?.orders[0]);
    expect(detail.fills[0]?.orderId).toBe(ask.id);
    expect((await buyer.browser.request('GET', `/api/orders/${ask.id}`)).statusCode).toBe(404);
    await context.marketState('pause');
    await seller.browser.request('POST', '/api/orders', command(context.sessionId, 'SELL', '0.1'));
    await seller.browser.request('POST', `/api/orders/${ask.id}/cancel`, {
      commandId: randomUUID(),
      sessionId: context.sessionId,
    });
    const after = (await seller.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(after.account?.openOrders).toEqual([]);
    expect(after.account?.orders[0]).toMatchObject({
      cancelReason: 'USER_REQUEST',
      executedQuantity: '0.1000',
      remaining: '0.3000',
      reserved: '0.0000',
    });
    expect(
      after.account?.commands.some(
        (row) => row.status === 'REJECTED' && row.code === 'MARKET_PAUSED',
      ),
    ).toBe(true);
    expect(
      after.account?.activity.some((row) => row.kind === 'CANCEL' && row.amount === '0.3000'),
    ).toBe(true);
    expect(BigInt(after.cursor)).toBeGreaterThan(BigInt(before.cursor));
  });

  it('rejects a stale browser actor when a different account cookie replaced its session', async () => {
    const first = await context.trader('first_trader');
    const second = await context.trader('second_trader');
    await context.marketState('resume');
    const body = command(context.sessionId, 'SELL', '0.1');
    const denied = await second.browser.request('POST', '/api/orders', body, {
      'x-sandbox-actor': first.user.accountId,
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.json()).toMatchObject({ code: 'SESSION_CHANGED' });
    expect((await context.sql.query('SELECT id FROM orders')).rows).toEqual([]);
    expect(
      (
        await context.sql.query('SELECT command_id FROM receipts WHERE command_id = $1', [
          body.commandId,
        ])
      ).rows,
    ).toEqual([]);
    const accepted = await second.browser.request('POST', '/api/orders', body, {
      'x-sandbox-actor': second.user.accountId,
    });
    expect(accepted.json()).toMatchObject({
      status: 'ACCEPTED',
      order: { accountId: second.user.accountId },
    });
  });

  it('provides coherent administration and system-account inspection with explicit permissions', async () => {
    const trader = await context.trader('trader');
    const workspace = (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(workspace.account).toBeUndefined();
    expect(workspace.admin?.traders[0]?.accountId).toBe(trader.user.accountId);
    expect(workspace.admin?.invitations[0]?.state).toBe('REDEEMED');
    expect(workspace.admin?.overview.counts.traders).toBe('1');
    expect(workspace.admin?.overview.feeAccountId).toBeTruthy();
    const account = (
      await context.admin.request('GET', `/api/admin/traders/${trader.user.accountId}/workspace`)
    ).json<AccountView>();
    expect(account.balances['BTC-SIM'].total).toBe('1.0000');
    const issuance = (
      await context.admin.request(
        'GET',
        `/api/admin/traders/${workspace.admin!.overview.issuanceAccountId}/workspace`,
      )
    ).json<AccountView>();
    expect(issuance.balances['BTC-SIM'].total).toBe('-1.0000');
    expect(issuance.activity).toHaveLength(2);
    expect(
      (await trader.browser.request('GET', `/api/admin/traders/${trader.user.accountId}/workspace`))
        .statusCode,
    ).toBe(403);
    expect((await context.client().request('GET', '/api/workspace')).statusCode).toBe(401);
    expect(JSON.stringify(workspace)).not.toMatch(/password_hash|csrf_hash|token_hash/);
    expect(JSON.stringify(workspace)).not.toContain(trader.invitation.token);
  });

  it('labels synthetic activity without exposing its account identities to traders', async () => {
    const trader = await context.trader('trader');
    const makerAccountId = randomUUID();
    const takerAccountId = randomUUID();
    await context.sql.query(
      `INSERT INTO accounts (id, kind, label) VALUES
        ($1, 'TRADER', 'Demo market maker'), ($2, 'TRADER', 'Demo market taker')`,
      [makerAccountId, takerAccountId],
    );
    await context.sql.query(
      `INSERT INTO demo_market (session_id, maker_account_id, taker_account_id, enabled, status)
        VALUES ($1, $2, $3, true, 'RUNNING')`,
      [context.sessionId, makerAccountId, takerAccountId],
    );
    const paused = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(paused.market.demoMarket).toEqual({
      enabled: true,
      status: 'PAUSED',
      updatedAt: expect.any(String),
    });
    expect(JSON.stringify(paused)).not.toContain(makerAccountId);
    expect(JSON.stringify(paused)).not.toContain(takerAccountId);
    await context.marketState('resume');
    const admin = (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(admin.admin?.overview.demoMarket).toMatchObject({
      enabled: true,
      status: 'RUNNING',
      makerAccountId,
      takerAccountId,
    });
    expect(admin.admin?.overview.counts.traders).toBe('1');
    expect(admin.admin?.traders).toHaveLength(1);
    const inspectPath = `/api/admin/traders/${makerAccountId}/workspace`;
    expect((await context.admin.request('GET', inspectPath)).statusCode).toBe(200);
    expect((await trader.browser.request('GET', inspectPath)).statusCode).toBe(403);

    await context.sql.query("UPDATE exchange_control SET fault = 'Test recorded fault'");
    const faulted = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(faulted.market.demoMarket?.status).toBe('FAULTED');
    expect(faulted.fault).toBe('ACCOUNTING_FAULT');
    expect(JSON.stringify(faulted)).not.toContain('Test recorded fault');

    await context.sql.query("UPDATE demo_market SET enabled = false, status = 'STOPPED'");
    const stopped = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(stopped.market.demoMarket).toMatchObject({ enabled: false, status: 'STOPPED' });
  });

  it('calculates exact order totals and whole candles beyond the displayed fill window', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.marketState('resume');
    const ask = await context.exchange.placeLimit({
      ...command(context.sessionId, 'SELL', '0.5'),
      accountId: seller.user.accountId,
    });
    for (let index = 0; index < 101; index += 1) {
      await context.exchange.placeLimit({
        ...command(context.sessionId, 'BUY', '0.001'),
        accountId: buyer.user.accountId,
      });
    }
    const detail = (
      await seller.browser.request('GET', `/api/orders/${ask.order!.id}`)
    ).json<OrderDetailResponse>();
    expect(detail.fills).toHaveLength(100);
    expect(detail.order).toMatchObject({
      executedQuantity: '0.1010',
      cumulativeFee: '5.050000000',
      averagePrice: '50000.000000000',
    });
    const workspace = (await seller.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(workspace.market.trades).toHaveLength(100);
    const volume = workspace.market.candles.reduce(
      (sum, candle) => sum + BigInt(candle.volume.replace('.', '')),
      0n,
    );
    expect(volume).toBe(1010n);
  });

  it('returns every open order even when it falls outside the recent history window', async () => {
    const trader = await context.trader('trader');
    await context.marketState('resume');
    const old = await context.exchange.placeLimit({
      ...command(context.sessionId, 'SELL', '0.1'),
      accountId: trader.user.accountId,
    });
    for (let index = 0; index < 100; index += 1) {
      const placed = await context.exchange.placeLimit({
        ...command(context.sessionId, 'BUY', '0.001', '10000'),
        accountId: trader.user.accountId,
      });
      await context.exchange.cancel({
        accountId: trader.user.accountId,
        sessionId: context.sessionId,
        commandId: randomUUID(),
        orderId: placed.order!.id,
      });
    }
    const workspace = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(workspace.account?.orders).toHaveLength(100);
    expect(workspace.account?.orders.some((row) => row.id === old.order!.id)).toBe(false);
    expect(workspace.account?.openOrders.map((row) => row.id)).toEqual([old.order!.id]);
    expect(workspace.account?.historyLimit).toBe(100);
  });

  it('keeps cursor, book, orders and balances at one PostgreSQL snapshot while another command commits', async () => {
    const trader = await context.trader('trader');
    await context.marketState('resume');
    const before = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    const original = context.exchange.readTransaction.bind(context.exchange);
    let release!: () => void;
    let frozen!: () => void;
    const freeze = new Promise<void>((resolve) => {
      frozen = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Direct query avoids pausing the HTTP authentication transaction instead.
    context.exchange.readTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        frozen();
        await proceed;
        return work(tx);
      });
    const { workspaceSnapshot } = await import('../../apps/server/src/workspace.js');
    const token = trader.browser.cookieHeader
      .split('; ')
      .find((row) => row.startsWith('sandbox_session='))!
      .split('=')[1]!;
    const pending = workspaceSnapshot(context.exchange, token);
    await freeze;
    context.exchange.readTransaction = original;
    try {
      await context.exchange.placeLimit({
        ...command(context.sessionId, 'SELL', '0.1'),
        accountId: trader.user.accountId,
      });
    } finally {
      release();
    }
    const during = await pending;
    expect(during.cursor).toBe(before.cursor);
    expect(during.account).toEqual(before.account);
    expect(during.market.book).toEqual(before.market.book);
    const after = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(after.account?.openOrders).toHaveLength(1);
    expect(BigInt(after.cursor)).toBeGreaterThan(BigInt(during.cursor));
  });
});
