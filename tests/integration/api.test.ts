import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, Snapshot } from '../../apps/server/src/types.js';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';

describe('authenticated HTTP boundary against PostgreSQL', () => {
  let context: ApiFixture;

  beforeEach(async () => {
    context = await createApiFixture();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  function order(side: 'BUY' | 'SELL' = 'SELL') {
    return {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side,
      quantity: '0.1',
      price: '50000',
    };
  }

  it('starts paused, creates one administrator without trading funds, and requires authentication', async () => {
    const anonymous = context.client();
    expect((await anonymous.request('GET', '/api/market')).statusCode).toBe(401);
    expect((await anonymous.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await anonymous.request('GET', '/api/admin/overview')).statusCode).toBe(401);
    expect((await context.admin.request('GET', '/api/market')).json()).toMatchObject({
      sessionId: context.sessionId,
      marketState: 'PAUSED',
    });
    expect((await context.admin.request('POST', '/api/orders', order())).statusCode).toBe(403);
    await expect(
      context.auth.bootstrapAdmin({ handle: 'another_operator', password: TEST_PASSWORD }),
    ).rejects.toThrow();
    const allocations = await context.sql.query(
      'SELECT count(*)::integer AS count FROM allocations',
    );
    expect(allocations.rows).toEqual([{ count: 0 }]);
  });

  it('rejects bad origins, missing CSRF, and caller-selected identities before financial mutation', async () => {
    const { browser } = await context.trader('trader');
    await context.marketState('resume');
    const before = (await browser.request('GET', '/api/me')).json();
    const command = order();
    expect(
      (await browser.request('POST', '/api/orders', command, { 'x-csrf-token': '' })).statusCode,
    ).toBe(403);
    expect(
      (await browser.request('POST', '/api/orders', command, { origin: 'https://other.invalid' }))
        .statusCode,
    ).toBe(403);
    expect((await browser.request('POST', '/api/orders', command, { origin: '' })).statusCode).toBe(
      403,
    );
    expect(
      (
        await browser.request('POST', '/api/orders', {
          ...command,
          accountId: randomUUID(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await browser.request('POST', '/api/orders', { ...command, quantity: 0.1 })).statusCode,
    ).toBe(400);
    expect((await browser.request('GET', '/api/me')).json()).toEqual(before);
    expect((await browser.request('GET', `/api/receipts/${command.commandId}`)).json()).toBeNull();

    const anonymous = context.client();
    expect(
      (
        await anonymous.request(
          'POST',
          '/api/auth/login',
          { handle: 'trader', password: TEST_PASSWORD },
          { origin: 'https://other.invalid' },
        )
      ).statusCode,
    ).toBe(403);
  });

  it('preserves exact accounting, receipt replay, and private ownership through HTTP', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    expect((await seller.browser.request('GET', '/api/admin/traders')).statusCode).toBe(403);
    await context.marketState('resume');
    const submission = { ...order(), quantity: '0.4' };
    const askResponse = await seller.browser.request('POST', '/api/orders', submission);
    expect(askResponse.statusCode).toBe(200);
    const ask = askResponse.json<CommandResult>();
    expect(ask.order).toMatchObject({ accountId: seller.user.accountId, remaining: '0.4000' });
    const bid = (
      await buyer.browser.request('POST', '/api/orders', order('BUY'))
    ).json<CommandResult>();
    expect(bid.fills).toHaveLength(1);
    expect(JSON.stringify(bid.fills)).not.toContain(ask.order!.id);
    expect(JSON.stringify(bid.fills)).not.toContain(seller.user.accountId);
    const sellerFills = (await seller.browser.request('GET', '/api/me')).json<Snapshot>().fills;
    expect(JSON.stringify(sellerFills)).not.toContain(bid.order!.id);
    expect(JSON.stringify(sellerFills)).not.toContain(buyer.user.accountId);

    const denied = await buyer.browser.request('POST', `/api/orders/${ask.order!.id}/cancel`, {
      commandId: randomUUID(),
      sessionId: context.sessionId,
    });
    expect(denied.json()).toMatchObject({ status: 'REJECTED', code: 'NOT_ORDER_OWNER' });
    expect(
      (await buyer.browser.request('GET', `/api/receipts/${submission.commandId}`)).json(),
    ).toBeNull();
    expect((await seller.browser.request('POST', '/api/orders', submission)).json()).toEqual(ask);
    expect(
      (await seller.browser.request('POST', '/api/orders', { ...submission, quantity: '0.3' }))
        .statusCode,
    ).toBe(409);
    expect((await seller.browser.request('GET', '/api/me')).json<Snapshot>().balances).toEqual({
      'BTC-SIM': { available: '0.6000', reserved: '0.3000', total: '0.9000' },
      'USD-SIM': {
        available: '104995.000000000',
        reserved: '0.000000000',
        total: '104995.000000000',
      },
    });
    const market = (await buyer.browser.request('GET', '/api/market')).json();
    const shared = JSON.stringify(market);
    for (const privateId of [
      seller.user.accountId,
      buyer.user.accountId,
      ask.order!.id,
      bid.order!.id,
    ]) {
      expect(shared).not.toContain(privateId);
    }
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('confirms pause before blocking new trades and still permits cancellation', async () => {
    const { browser } = await context.trader('trader');
    await context.marketState('resume');
    const placed = (await browser.request('POST', '/api/orders', order())).json<CommandResult>();
    expect((await context.marketState('pause')).json()).toMatchObject({ status: 'ACCEPTED' });
    expect((await browser.request('POST', '/api/orders', order())).json()).toMatchObject({
      status: 'REJECTED',
      code: 'MARKET_PAUSED',
    });
    const canceled = await browser.request('POST', `/api/orders/${placed.order!.id}/cancel`, {
      commandId: randomUUID(),
      sessionId: context.sessionId,
    });
    expect(canceled.json()).toMatchObject({ order: { status: 'CANCELED', reserved: '0.0000' } });
    expect((await browser.request('GET', '/api/me')).json<Snapshot>().balances['BTC-SIM']).toEqual({
      available: '1.0000',
      reserved: '0.0000',
      total: '1.0000',
    });
    await context.marketState('resume');
    const replacement = (
      await browser.request('POST', '/api/orders', order())
    ).json<CommandResult>();
    expect(replacement.status).toBe('ACCEPTED');
    const adminCancel = await context.admin.request(
      'POST',
      `/api/admin/orders/${replacement.order!.id}/cancel`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Explain the administrative cancellation',
      },
    );
    expect(adminCancel.json()).toMatchObject({
      status: 'ACCEPTED',
      data: {
        order: {
          status: 'CANCELED',
          reserved: '0.0000',
          cancelReason: 'ADMIN_REQUEST: Explain the administrative cancellation',
        },
      },
    });
  });

  it('revokes logout and password sessions durably while leaving resting orders intact', async () => {
    const { browser } = await context.trader('trader');
    const other = context.client();
    const signedIn = await other.login('trader');
    expect(signedIn.statusCode).toBe(200);
    const setCookie = signedIn.headers['set-cookie'];
    const cookies = typeof setCookie === 'string' ? [setCookie] : (setCookie ?? []);
    expect(cookies.find((cookie) => cookie.startsWith('sandbox_session='))).toMatch(/HttpOnly/i);
    expect(cookies.find((cookie) => cookie.startsWith('sandbox_session='))).toMatch(
      /SameSite=Strict/i,
    );
    expect(cookies.find((cookie) => cookie.startsWith('sandbox_csrf='))).not.toMatch(/HttpOnly/i);
    await context.marketState('resume');
    const command = order();
    const placed = (await browser.request('POST', '/api/orders', command)).json<CommandResult>();
    const oldCookie = browser.cookieHeader;
    const oldCsrf = browser.csrfToken;
    const changed = await browser.request('POST', '/api/auth/password', {
      currentPassword: TEST_PASSWORD,
      newPassword: 'replacement-test-password',
    });
    expect(changed.statusCode).toBe(200);
    expect(browser.cookieHeader).not.toBe(oldCookie);
    expect(browser.csrfToken).not.toBe(oldCsrf);
    expect(
      (await context.client().request('GET', '/api/me', undefined, { cookie: oldCookie }))
        .statusCode,
    ).toBe(401);
    expect((await other.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await browser.request('GET', '/api/me')).json<Snapshot>().orders[0]).toMatchObject({
      id: placed.order!.id,
      status: 'OPEN',
    });
    await context.start();
    expect((await browser.request('GET', '/api/receipts/' + command.commandId)).json()).toEqual(
      placed,
    );
    expect((await other.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await browser.request('POST', '/api/auth/logout', {})).statusCode).toBe(200);
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await other.login('trader')).statusCode).toBe(401);
    expect((await other.login('trader', 'replacement-test-password')).statusCode).toBe(200);
    expect((await other.request('GET', '/api/me')).json<Snapshot>().orders[0]).toMatchObject({
      id: placed.order!.id,
      status: 'OPEN',
    });
  });

  it('suspends access and cancels only remaining quantity, then reinstates without another allocation', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.marketState('resume');
    const ask = (
      await seller.browser.request('POST', '/api/orders', { ...order(), quantity: '0.4' })
    ).json<CommandResult>();
    await buyer.browser.request('POST', '/api/orders', order('BUY'));
    const suspension = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Suspend the participant during an open order',
    };
    const first = await context.admin.request(
      'POST',
      `/api/admin/traders/${seller.user.accountId}/suspend`,
      suspension,
    );
    expect(first.json()).toMatchObject({ status: 'ACCEPTED' });
    expect(
      (
        await context.admin.request(
          'POST',
          `/api/admin/traders/${seller.user.accountId}/suspend`,
          suspension,
        )
      ).json(),
    ).toEqual(first.json());
    expect((await seller.browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await context.client().login('seller')).statusCode).toBe(401);
    const restricted = (
      await context.admin.request('GET', `/api/admin/traders/${seller.user.accountId}`)
    ).json<Snapshot>();
    expect(restricted.orders[0]).toMatchObject({
      id: ask.order!.id,
      status: 'CANCELED',
      remaining: '0.3000',
      reserved: '0.0000',
    });
    expect(restricted.fills).toHaveLength(1);
    expect(restricted.balances['BTC-SIM'].total).toBe('0.9000');
    expect(restricted.balances['USD-SIM'].total).toBe('104995.000000000');
    const reinstated = await context.admin.request(
      'POST',
      `/api/admin/traders/${seller.user.accountId}/reinstate`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Restore account access',
      },
    );
    expect(reinstated.json()).toMatchObject({ status: 'ACCEPTED' });
    expect((await seller.browser.login('seller')).statusCode).toBe(200);
    const restored = (await seller.browser.request('GET', '/api/me')).json<Snapshot>();
    expect(restored).toMatchObject({ balances: restricted.balances, orders: restricted.orders });
    expect(restored.fills.map((fill) => fill.id)).toEqual(restricted.fills.map((fill) => fill.id));
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('grants only while paused, resolves retries, and audits without secret fields', async () => {
    const { browser, user, invitation } = await context.trader('trader');
    const command = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      accountId: user.accountId,
      asset: 'USD-SIM',
      amount: '12.345678901',
      reason: 'Exercise exact virtual issuance',
    };
    const first = await context.admin.request('POST', '/api/admin/grants', command);
    expect(first.json()).toMatchObject({ status: 'ACCEPTED' });
    expect((await context.admin.request('POST', '/api/admin/grants', command)).json()).toEqual(
      first.json(),
    );
    expect(
      (await context.admin.request('POST', '/api/admin/grants', { ...command, amount: '99' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await browser.request('GET', '/api/me')).json<Snapshot>().balances['USD-SIM'].total,
    ).toBe('100012.345678901');
    await context.marketState('resume');
    expect(
      (
        await context.admin.request('POST', '/api/admin/grants', {
          ...command,
          commandId: randomUUID(),
        })
      ).json(),
    ).toMatchObject({ status: 'REJECTED' });
    const audit = await context.admin.request('GET', '/api/admin/audit');
    expect(audit.statusCode).toBe(200);
    const serialized = JSON.stringify(audit.json());
    expect(serialized).toContain(command.reason);
    for (const secret of [TEST_PASSWORD, invitation.token, browser.csrfToken])
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/password_hash|token_hash|csrf_hash/);
    await expect(
      context.sql.query('UPDATE grants SET reason = $1 WHERE command_id = $2', [
        'Rewritten history',
        command.commandId,
      ]),
    ).rejects.toThrow();
    await expect(
      context.sql.query('DELETE FROM admin_audit WHERE command_id = $1', [command.commandId]),
    ).rejects.toThrow();
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('keeps access revocation effective when suspension discovers an accounting fault', async () => {
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const placed = (await browser.request('POST', '/api/orders', order())).json<CommandResult>();
    // Owner-only corruption probe: the order and ledger still reserve 0.1 BTC.
    await context.sql.query(
      `UPDATE balances SET amount = 0
       WHERE session_id = $1 AND account_id = $2 AND asset = 'BTC-SIM' AND bucket = 'RESERVED'`,
      [context.sessionId, user.accountId],
    );
    const suspension = await context.admin.request(
      'POST',
      `/api/admin/traders/${user.accountId}/suspend`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Revoke access despite a broken reservation projection',
      },
    );
    expect(suspension.statusCode).toBe(200);
    expect(suspension.json()).toMatchObject({
      status: 'ACCEPTED',
      data: { accountStatus: 'SUSPENDED', pendingCancellation: true, canceledOrders: [] },
    });
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await context.client().login('trader')).statusCode).toBe(401);
    const inspected = (
      await context.admin.request('GET', `/api/admin/traders/${user.accountId}`)
    ).json<Snapshot>();
    expect(inspected.orders[0]).toMatchObject({
      id: placed.order!.id,
      status: 'OPEN',
      reserved: '0.1000',
    });
    const overview = (await context.admin.request('GET', '/api/admin/overview')).json<{
      fault: string | null;
      marketState: string;
    }>();
    expect(overview.fault).toBeTruthy();
    expect(overview.marketState).toBe('PAUSED');
    expect((await context.marketState('resume')).json()).toMatchObject({
      status: 'REJECTED',
      code: 'RECOVERY_REQUIRED',
    });
    const grant = await context.admin.request('POST', '/api/admin/grants', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      accountId: user.accountId,
      asset: 'USD-SIM',
      amount: '1',
      reason: 'A fault cannot be bypassed by issuing funds',
    });
    expect(grant.statusCode).toBe(503);
    expect((await context.admin.request('GET', '/api/admin/audit')).statusCode).toBe(200);
    await context.start();
    expect((await context.admin.request('GET', '/api/admin/overview')).json()).toMatchObject({
      marketState: 'PAUSED',
    });
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await context.admin.request('GET', '/api/admin/traders')).body).toContain(
      '"pendingCancellation":true',
    );
  });

  it('rechecks a session revoked after HTTP authentication while its order waits for admission', async () => {
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const command = order();
    const owner = await context.sql.connect();
    let pending: ReturnType<typeof browser.request> | undefined;
    try {
      await owner.query('BEGIN');
      const holder = await owner.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await owner.query('SELECT id FROM exchange_control WHERE id = 1 FOR UPDATE');
      pending = browser.request('POST', '/api/orders', command);
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const blocked = await context.sql.query<{ waiting: boolean }>(
          `
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE $1 = ANY(pg_blocking_pids(pid))
              AND wait_event_type = 'Lock'
              AND query ILIKE '%exchange_control%'
          ) AS waiting
        `,
          [holder.rows[0]!.pid],
        );
        waiting = blocked.rows[0]!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      // The HTTP pre-handler has completed, but the protected command has not
      // acquired its installation lock. Revoke before releasing that boundary.
      await owner.query(
        'UPDATE login_sessions SET revoked_at = clock_timestamp() WHERE account_id = $1',
        [user.accountId],
      );
      await owner.query('COMMIT');
      const response = await pending;
      expect(response.statusCode).toBe(401);
      expect(
        (await context.sql.query('SELECT id FROM orders WHERE account_id = $1', [user.accountId]))
          .rows,
      ).toEqual([]);
      expect(
        (
          await context.sql.query(
            'SELECT command_id FROM receipts WHERE actor_id = $1 AND command_id = $2',
            [user.accountId, command.commandId],
          )
        ).rows,
      ).toEqual([]);
      expect((await context.exchange.snapshot(user.accountId)).balances['BTC-SIM'].reserved).toBe(
        '0.0000',
      );
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      await owner.query('ROLLBACK');
      owner.release();
      await pending;
    }
  });
});
