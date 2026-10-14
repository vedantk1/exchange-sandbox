import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AdminResult } from '../../apps/server/src/admin/service.js';
import type { CommandResult } from '../../apps/server/src/types.js';
import type { HistoryView, WorkspaceView } from '../../packages/contracts/src/index.js';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';
import { killAtTransactionBoundary } from '../helpers/crash.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('durable session lifecycle and retained financial history', () => {
  let context: ApiFixture;
  let holdGate = false;
  let entered: ReturnType<typeof deferred>;
  let release: ReturnType<typeof deferred>;
  beforeEach(async () => {
    holdGate = false;
    entered = deferred();
    release = deferred();
    context = await createApiFixture({
      hooks: {
        afterRolloverGate: async () => {
          if (!holdGate) return;
          entered.resolve();
          await release.promise;
        },
      },
    });
  });
  afterEach(async () => {
    release.resolve();
    await context?.dispose();
  });
  function command(sessionId = context.sessionId) {
    return {
      commandId: randomUUID(),
      sessionId,
      reason: 'Archive this isolated session and start fresh',
    };
  }
  function orderIdentity() {
    return { commandId: randomUUID(), sessionId: context.sessionId };
  }
  async function rollover(input = command()) {
    const response = await context.admin.request('POST', '/api/admin/sessions/rollover', input);
    expect(response.statusCode).toBe(200);
    return response.json<AdminResult>();
  }
  async function session() {
    return (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
  }

  it('cancels only remaining orders, preserves exact old balances and creates funded paused accounts once', async () => {
    const maker = await context.trader('maker');
    const buyer = await context.trader('buyer');
    await context.admin.request('POST', '/api/admin/simulator/start', command());
    const original = (await session()).admin!.overview.demoMarket!;
    await context.marketState('resume');
    const sell = (
      await maker.browser.request('POST', '/api/orders', {
        ...orderIdentity(),
        side: 'SELL',
        quantity: '0.4',
        price: '50000',
      })
    ).json<CommandResult>();
    expect(sell.status).toBe('ACCEPTED');
    const buyInput = { ...orderIdentity(), side: 'BUY', quantity: '0.1', price: '50000' };
    const buy = (
      await buyer.browser.request('POST', '/api/orders', buyInput)
    ).json<CommandResult>();
    expect(buy.status).toBe('ACCEPTED');
    await context.marketState('pause');
    const input = command();
    const result = await rollover(input);
    expect(result).toMatchObject({
      status: 'ACCEPTED',
      data: {
        previousSessionId: context.sessionId,
        allocatedAccountCount: 4,
        canceledOrderCount: 1,
      },
    });
    const next = result.data!.newSessionId as string;
    expect(next).not.toBe(context.sessionId);
    expect(await rollover(input)).toEqual(result);
    const current = await session();
    expect(current).toMatchObject({ sessionId: next, marketState: 'PAUSED', fault: null });
    expect(current.rollover).toBeUndefined();
    expect(current.admin!.overview.demoMarket).toMatchObject({
      enabled: false,
      status: 'STOPPED',
      makerAccountId: original.makerAccountId,
      takerAccountId: original.takerAccountId,
    });
    const history = (
      await maker.browser.request('GET', `/api/history/${context.sessionId}`)
    ).json<HistoryView>();
    expect(history.session).toMatchObject({ id: context.sessionId, state: 'CLOSED' });
    expect(history.session.closedAt).not.toBeNull();
    const boundary = await context.sql.query(
      'SELECT (SELECT closed_at FROM exchange_sessions WHERE id=$1) = (SELECT created_at FROM exchange_sessions WHERE id=$2) AS coherent',
      [context.sessionId, next],
    );
    expect(boundary.rows[0]!.coherent).toBe(true);
    expect(history.account!.balances['BTC-SIM']).toEqual({
      available: '0.9000',
      reserved: '0.0000',
      total: '0.9000',
    });
    expect(history.account!.balances['USD-SIM']).toEqual({
      available: '104995.000000000',
      reserved: '0.000000000',
      total: '104995.000000000',
    });
    expect(history.account!.orders[0]).toMatchObject({
      id: sell.order!.id,
      status: 'CANCELED',
      remaining: '0.3000',
      cancelReason: 'SESSION_ENDED',
    });
    expect(history.account!.fills).toHaveLength(1);
    expect(history.account!.openOrders).toHaveLength(0);
    const funded = (await maker.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(funded.account!.balances['BTC-SIM'].available).toBe('1.0000');
    expect(funded.account!.balances['USD-SIM'].available).toBe('100000.000000000');
    expect(funded.account!.orders).toHaveLength(0);
    expect((await buyer.browser.request('POST', '/api/orders', buyInput)).json()).toEqual(buy);
    const counts = await context.sql.query(
      'SELECT session_id, count(*)::int AS count FROM allocations GROUP BY session_id',
    );
    expect(counts.rows).toEqual(
      expect.arrayContaining([
        { session_id: context.sessionId, count: 4 },
        { session_id: next, count: 4 },
      ]),
    );
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('retains suspended restrictions and issues a new-session allocation only at first reinstatement', async () => {
    const trader = await context.trader('restricted');
    await context.admin.request(
      'POST',
      `/api/admin/traders/${trader.user.accountId}/suspend`,
      command(),
    );
    const result = await rollover();
    const next = result.data!.newSessionId as string;
    expect(result.data!.allocatedAccountCount).toBe(0);
    expect((await trader.browser.login('restricted')).statusCode).toBe(401);
    expect(
      (
        await context.sql.query(
          'SELECT count(*)::int AS count FROM allocations WHERE session_id = $1',
          [next],
        )
      ).rows[0]!.count,
    ).toBe(0);
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await context.admin.request(
            'POST',
            `/api/admin/traders/${trader.user.accountId}/reinstate`,
            command(next),
          )
        ).json(),
      ).toMatchObject({ status: 'ACCEPTED' });
    }
    expect((await trader.browser.login('restricted')).statusCode).toBe(200);
    const current = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(current.account!.balances['BTC-SIM'].available).toBe('1.0000');
    expect(current.account!.balances['USD-SIM'].available).toBe('100000.000000000');
    expect(
      (
        await context.sql.query(
          'SELECT count(*)::int AS count FROM allocations WHERE session_id = $1',
          [next],
        )
      ).rows[0]!.count,
    ).toBe(1);
  });

  it('preserves outstanding invitation expiry and funds redemption in the new session only', async () => {
    const invitation = await context.invite();
    const before = await context.sql.query(
      'SELECT expires_at, token_hash FROM invitations WHERE id=$1',
      [invitation.id],
    );
    const result = await rollover();
    const browser = context.client();
    expect(
      (
        await browser.request('POST', '/api/auth/redeem', {
          token: invitation.token,
          handle: 'later',
          password: TEST_PASSWORD,
        })
      ).statusCode,
    ).toBe(200);
    const after = await context.sql.query(
      'SELECT expires_at, token_hash FROM invitations WHERE id=$1',
      [invitation.id],
    );
    expect(after.rows).toEqual(before.rows);
    const allocations = await context.sql.query('SELECT session_id FROM allocations');
    expect(allocations.rows).toEqual([{ session_id: result.data!.newSessionId }]);
  });

  it('blocks financial admission under the durable gate without consuming invitations', async () => {
    const trader = await context.trader('active');
    const restricted = await context.trader('restricted');
    await context.admin.request(
      'POST',
      `/api/admin/traders/${restricted.user.accountId}/suspend`,
      command(),
    );
    const invitation = await context.invite();
    holdGate = true;
    const pending = rollover();
    await entered.promise;
    try {
      const read = await session();
      expect(read.rollover).toMatchObject({
        state: 'IN_PROGRESS',
        previousSessionId: context.sessionId,
      });
      expect((await context.admin.request('GET', '/health/ready')).statusCode).toBe(503);
      const grant = await context.admin.request('POST', '/api/admin/grants', {
        ...command(),
        accountId: trader.user.accountId,
        asset: 'USD-SIM',
        amount: '1',
      });
      expect(grant.statusCode).toBe(503);
      expect(grant.json()).toMatchObject({ code: 'SESSION_ROLLING_OVER' });
      const reinstate = await context.admin.request(
        'POST',
        `/api/admin/traders/${restricted.user.accountId}/reinstate`,
        command(),
      );
      expect(reinstate.statusCode).toBe(503);
      const browser = context.client();
      const redemption = await browser.request('POST', '/api/auth/redeem', {
        token: invitation.token,
        handle: 'waiting',
        password: TEST_PASSWORD,
      });
      expect(redemption.statusCode).toBe(503);
      expect(
        (
          await context.sql.query('SELECT redeemed_at FROM invitations WHERE id=$1', [
            invitation.id,
          ])
        ).rows[0]!.redeemed_at,
      ).toBeNull();
      const revoke = await context.admin.request(
        'POST',
        `/api/admin/traders/${trader.user.accountId}/suspend`,
        command(),
      );
      expect(revoke.json()).toMatchObject({ status: 'ACCEPTED' });
      expect((await trader.browser.request('GET', '/api/workspace')).statusCode).toBe(401);
    } finally {
      release.resolve();
      await pending;
    }
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM grants')).rows[0]!.count,
    ).toBe(0);
    expect(
      (
        await context.sql.query(
          'SELECT count(*)::int AS count FROM allocations WHERE session_id=(SELECT active_session_id FROM exchange_control)',
        )
      ).rows[0]!.count,
    ).toBe(0);
    const browser = context.client();
    expect(
      (
        await browser.request('POST', '/api/auth/redeem', {
          token: invitation.token,
          handle: 'waiting',
          password: TEST_PASSWORD,
        })
      ).statusCode,
    ).toBe(200);
  });

  it('coalesces concurrent retries and refuses competing obsolete transitions', async () => {
    const input = command();
    const results = await Promise.all([rollover(input), rollover(input)]);
    expect(results[1]).toEqual(results[0]);
    expect((await rollover()).code).toBe('STALE_SESSION');
    const conflict = await context.admin.request('POST', '/api/admin/sessions/rollover', {
      ...input,
      reason: 'A different payload must not reuse this command',
    });
    expect(conflict.statusCode).toBe(409);
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
        .count,
    ).toBe(2);
  });

  it('requires pause, healthy accounting, administrator role and CSRF protection', async () => {
    const trader = await context.trader('trader');
    expect(
      (await trader.browser.request('POST', '/api/admin/sessions/rollover', command())).statusCode,
    ).toBe(403);
    expect(
      (
        await context.admin.request('POST', '/api/admin/sessions/rollover', command(), {
          'x-csrf-token': '',
        })
      ).statusCode,
    ).toBe(403);
    await context.marketState('resume');
    expect((await rollover()).code).toBe('MARKET_MUST_BE_PAUSED');
    await context.marketState('pause');
    await context.sql.query("UPDATE exchange_control SET fault='Injected accounting fault'");
    const faulted = await context.admin.request('POST', '/api/admin/sessions/rollover', command());
    expect(faulted.json()).toMatchObject({ status: 'REJECTED', code: 'RECOVERY_REQUIRED' });
    expect(
      (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
        .count,
    ).toBe(1);
  });

  it('rejects new old-session orders while retaining original order receipts and private archive ownership', async () => {
    const trader = await context.trader('trader');
    const other = await context.trader('other');
    await context.marketState('resume');
    const input = { ...orderIdentity(), side: 'SELL', quantity: '0.1', price: '50000' };
    const original = (
      await trader.browser.request('POST', '/api/orders', input)
    ).json<CommandResult>();
    expect(original.status).toBe('ACCEPTED');
    await context.marketState('pause');
    await rollover();
    expect((await trader.browser.request('POST', '/api/orders', input)).json()).toEqual(original);
    expect(
      (
        await trader.browser.request('POST', '/api/orders', { ...input, commandId: randomUUID() })
      ).json(),
    ).toMatchObject({ status: 'REJECTED', code: 'STALE_SESSION' });
    expect(
      (await trader.browser.request('GET', `/api/orders/${original.order!.id}`)).json(),
    ).toMatchObject({ order: { status: 'CANCELED' } });
    expect(
      (await other.browser.request('GET', `/api/orders/${original.order!.id}`)).statusCode,
    ).toBe(404);
    expect(
      (
        await other.browser.request(
          'GET',
          `/api/history/${context.sessionId}/page?kind=orders&accountId=${trader.user.accountId}`,
        )
      ).statusCode,
    ).toBe(403);
    await expect(
      context.sql.query('UPDATE orders SET cancel_reason=$1 WHERE id=$2', [
        'rewritten',
        original.order!.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  for (const stage of [
    'afterRolloverGate',
    'beforeRolloverCommit',
    'afterRolloverCommit',
  ] as const) {
    it(`recovers exactly one transition after actual SIGKILL at ${stage}`, async () => {
      const trader = await context.trader('trader');
      const token = (await context.auth.login({ handle: 'operator', password: TEST_PASSWORD }))
        .token;
      const input = command();
      await context.stop();
      await killAtTransactionBoundary(context.url, stage, input, 'rollover', token);
      await context.start();
      const result = await rollover(input);
      expect(result).toMatchObject({
        status: 'ACCEPTED',
        data: { previousSessionId: context.sessionId, allocatedAccountCount: 1 },
      });
      expect((await session()).sessionId).toBe(result.data!.newSessionId);
      expect(
        (await context.sql.query('SELECT count(*)::int AS count FROM exchange_sessions')).rows[0]!
          .count,
      ).toBe(2);
      const allocation = await context.sql.query(
        'SELECT count(*)::int AS count FROM allocations WHERE session_id=$1 AND account_id=$2',
        [result.data!.newSessionId, trader.user.accountId],
      );
      expect(allocation.rows[0]!.count).toBe(1);
      expect((await context.sql.query('SELECT state FROM session_rollovers')).rows).toEqual([
        { state: 'COMPLETED' },
      ]);
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    });
  }
});
