import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

describe('isolated market snapshots', () => {
  let context: ApiFixture;
  afterEach(async () => context?.dispose());

  it('reads the committed market while a writer waits and never observes an uncommitted transition', async () => {
    context = await createApiFixture();
    const { browser } = await context.trader('trader');
    await context.marketState('resume');
    const order = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '50000',
    };
    expect((await browser.request('POST', '/api/orders', order)).statusCode).toBe(200);
    const holder = await context.sql.connect();
    await holder.query('BEGIN');
    const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await holder.query("UPDATE exchange_control SET market_state = 'PAUSED' WHERE id = 1");
    const pending = browser.request('POST', '/api/orders', { ...order, commandId: randomUUID() });
    try {
      const deadline = performance.now() + 1_000;
      let waiting = false;
      while (performance.now() < deadline) {
        const result = await context.sql.query(
          `SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock' AND query ILIKE '%exchange_control%'`,
          [rows[0]!.pid],
        );
        waiting = result.rows.length > 0;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      const market = await browser.request('GET', '/api/market');
      expect(market.statusCode).toBe(200);
      expect(market.json()).toMatchObject({
        sessionId: context.sessionId,
        marketState: 'TRADING',
        fault: null,
        book: { bids: [], asks: [{ price: '50000.00', quantity: '0.1000' }] },
        trades: [],
      });
      // The holder still owns the row; a market read must finish without its release.
      expect((await holder.query('SELECT market_state FROM exchange_control')).rows[0]).toEqual({
        market_state: 'PAUSED',
      });
      await holder.query('COMMIT');
      expect((await pending).json()).toMatchObject({ status: 'REJECTED', code: 'MARKET_PAUSED' });
      expect((await browser.request('GET', '/api/market')).json()).toMatchObject({
        marketState: 'PAUSED',
      });
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  });

  it('requires a valid active principal even though market reads do not acquire the writer lock', async () => {
    context = await createApiFixture();
    expect((await context.client().request('GET', '/api/market')).statusCode).toBe(401);
    const { browser, user } = await context.trader('trader');
    expect((await browser.request('GET', '/api/market')).statusCode).toBe(200);
    const suspended = await context.admin.request(
      'POST',
      `/api/admin/traders/${user.accountId}/suspend`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Exercise active-principal checks on isolated reads',
      },
    );
    expect(suspended.statusCode).toBe(200);
    expect((await browser.request('GET', '/api/market')).statusCode).toBe(401);
  });

  it('reports a private runtime fault even when recording the halt fails', async () => {
    context = await createApiFixture();
    const { browser, user } = await context.trader('trader');
    await context.sql.query(`
      CREATE FUNCTION reject_fault_diagnostic() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected diagnostic write failure'; END; $$;
      CREATE TRIGGER reject_fault_diagnostic BEFORE UPDATE OF fault ON exchange_control
      FOR EACH ROW WHEN (NEW.fault IS NOT NULL) EXECUTE FUNCTION reject_fault_diagnostic();
    `);
    try {
      await expect(
        context.exchange.financialTransaction(async () => {
          const error = new Error('Private invariant diagnostic');
          Object.assign(error, { code: '23514' });
          throw error;
        }),
      ).rejects.toThrow('Injected diagnostic write failure');
      expect((await context.sql.query('SELECT fault FROM exchange_control')).rows).toEqual([
        { fault: null },
      ]);
      const market = await browser.request('GET', '/api/market');
      expect(market.statusCode).toBe(200);
      expect(market.json()).toMatchObject({ fault: 'ACCOUNTING_FAULT' });
      expect(market.body).not.toContain('Financial invariant');
      expect(market.body).not.toContain('Private invariant');
      await expect(
        context.exchange.placeLimit({
          accountId: user.accountId,
          commandId: randomUUID(),
          sessionId: context.sessionId,
          side: 'BUY',
          quantity: '0.1',
          price: '50000',
        }),
      ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    } finally {
      await context.sql.query('DROP TRIGGER reject_fault_diagnostic ON exchange_control');
    }
  });
});
