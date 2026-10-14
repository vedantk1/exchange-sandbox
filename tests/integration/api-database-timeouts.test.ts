import { randomUUID } from 'node:crypto';
import { DEFAULT_DATABASE_BUDGETS } from '../../packages/database/src/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';

describe('recoverable HTTP database budgets', () => {
  let context: ApiFixture;
  afterEach(async () => context?.dispose());

  it('returns a recoverable 503 for a canceled SQL statement and retries the original command exactly once', async () => {
    const budgets = structuredClone(DEFAULT_DATABASE_BUDGETS);
    context = await createApiFixture({ database: { budgets } });
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const before = await context.exchange.snapshot(user.accountId);
    const command = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '50000',
    };
    await context.sql.query(`
      CREATE FUNCTION slow_order_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(2); RETURN NEW; END; $$;
      CREATE TRIGGER slow_order_insert BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION slow_order_insert();
    `);
    budgets.command = { statementMs: 150, totalMs: 1_000 };
    try {
      const response = await browser.request('POST', '/api/orders', command);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'DATABASE_TIMEOUT' });
      expect(response.body).not.toContain('slow_order_insert');
      expect(await context.exchange.getReceipt(user.accountId, command.commandId)).toBeNull();
      expect(await context.exchange.snapshot(user.accountId)).toEqual(before);
      expect((await context.sql.query('SELECT fault FROM exchange_control')).rows).toEqual([
        { fault: null },
      ]);
    } finally {
      budgets.command = DEFAULT_DATABASE_BUDGETS.command;
      await context.sql.query('DROP TRIGGER slow_order_insert ON orders');
    }
    const accepted = await browser.request('POST', '/api/orders', command);
    expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', order: { status: 'OPEN' } });
    expect((await browser.request('POST', '/api/orders', command)).json()).toEqual(accepted.json());
    await context.start();
    expect((await browser.request('POST', '/api/orders', command)).json()).toEqual(accepted.json());
    expect((await context.exchange.snapshot(user.accountId)).orders).toHaveLength(1);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('fences an expired callback before responding and cannot commit when it later resumes', async () => {
    const budgets = structuredClone(DEFAULT_DATABASE_BUDGETS);
    const commandId = randomUUID();
    let admitted!: () => void;
    let resume!: () => void;
    const admission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      resume = resolve;
    });
    context = await createApiFixture({
      database: { budgets },
      hooks: {
        beforeCommit: async (id) => {
          if (id === commandId) {
            admitted();
            await continuation;
          }
        },
      },
    });
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const before = await context.exchange.snapshot(user.accountId);
    const command = {
      commandId,
      sessionId: context.sessionId,
      side: 'BUY',
      quantity: '0.1',
      price: '50000',
    };
    budgets.command = { statementMs: 300, totalMs: 800 };
    try {
      const pending = browser.request('POST', '/api/orders', command);
      await admission;
      const response = await pending;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'DATABASE_TIMEOUT' });
      resume();
      expect(await context.exchange.getReceipt(user.accountId, commandId)).toBeNull();
      expect(await context.exchange.snapshot(user.accountId)).toEqual(before);
      expect((await context.sql.query('SELECT fault FROM exchange_control')).rows).toEqual([
        { fault: null },
      ]);
      budgets.command = DEFAULT_DATABASE_BUDGETS.command;
      const accepted = await browser.request('POST', '/api/orders', command);
      expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', order: { status: 'OPEN' } });
      expect((await browser.request('POST', '/api/orders', command)).json()).toEqual(
        accepted.json(),
      );
      expect((await context.exchange.snapshot(user.accountId)).orders).toHaveLength(1);
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      resume();
      budgets.command = DEFAULT_DATABASE_BUDGETS.command;
    }
  });
});
