import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import * as database from '../../packages/database/src/index.js';
import { INITIAL_SCHEMA } from '../../packages/database/src/schema.js';
import { IDENTITY_SCHEMA } from '../../packages/database/src/identity-schema.js';
import { DEMO_MARKET_SCHEMA } from '../../packages/database/src/demo-market-schema.js';
import { SIMULATOR_CONTROLS_SCHEMA } from '../../packages/database/src/simulator-controls-schema.js';
import { MARKET_ORDERS_SCHEMA } from '../../packages/database/src/market-orders-schema.js';
import { SESSION_LIFECYCLE_SCHEMA } from '../../packages/database/src/session-lifecycle-schema.js';
import { COMMAND_TIMESTAMP_SCHEMA } from '../../packages/database/src/command-timestamp-schema.js';
import { Exchange } from '../../apps/server/src/exchange.js';
import { createUpgradeDatabase } from '../helpers/api-upgrade.js';

const legacyMigrations = [
  ['001_exchange_core', INITIAL_SCHEMA],
  ['002_identity_and_controls', IDENTITY_SCHEMA],
  ['003_demo_market', DEMO_MARKET_SCHEMA],
  ['004_simulator_controls', SIMULATOR_CONTROLS_SCHEMA],
  ['005_market_orders', MARKET_ORDERS_SCHEMA],
  ['006_session_lifecycle', SESSION_LIFECYCLE_SCHEMA],
  ['007_command_timestamps', COMMAND_TIMESTAMP_SCHEMA],
] as const;

it('protects existing007 orders without rewriting evidence or changing recovery results', async () => {
  const context = await createUpgradeDatabase();
  let exchange: Exchange | undefined;
  try {
    const connection = await context.sql.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      for (const [name, statement] of legacyMigrations) {
        await connection.query(statement);
        await connection.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }

    // Seed genuine001–007 tables with the current,007-compatible financial
    // commands. Bypass only the version gate for this one legacy startup; no008
    // schema objects are created or removed. This is a schema upgrade fixture,
    // not a frozen historical application release.
    const legacyVerification = vi
      .spyOn(database, 'verifyMigrations')
      .mockImplementationOnce(async (connection) => {
        const versions = await connection
          .selectFrom('schema_migrations')
          .select('name')
          .orderBy('name')
          .execute();
        expect(versions.map(({ name }) => name)).toEqual(legacyMigrations.map(([name]) => name));
      });
    try {
      exchange = await Exchange.open(context.url, { migrations: 'verify' });
    } finally {
      legacyVerification.mockRestore();
    }
    const { sessionId } = await exchange.bootstrap();
    const seller = randomUUID();
    const buyer = randomUUID();
    await exchange.createTrader({ accountId: seller, label: 'seller', commandId: randomUUID() });
    await exchange.createTrader({ accountId: buyer, label: 'buyer', commandId: randomUUID() });
    const partial = await exchange.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      side: 'SELL',
      quantity: '0.3',
      price: '50000',
    });
    const originalBuy = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    const filled = await exchange.placeLimit(originalBuy);
    const open = await exchange.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      side: 'SELL',
      quantity: '0.2',
      price: '51000',
    });
    const canceledOrder = await exchange.placeLimit({
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      side: 'BUY',
      quantity: '0.1',
      price: '40000',
    });
    const originalCancel = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      orderId: canceledOrder.order!.id,
    };
    const canceled = await exchange.cancel(originalCancel);
    const preview = await exchange.previewMarket({
      accountId: buyer,
      sessionId,
      side: 'BUY',
      quantity: '0.05',
    });
    const originalMarket = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      previewId: preview.previewId,
    };
    const market = await exchange.placeMarket(originalMarket);
    expect(filled.order?.status).toBe('FILLED');
    expect(canceled.order?.status).toBe('CANCELED');
    expect(open.order?.status).toBe('OPEN');
    expect(market.order).toMatchObject({ type: 'MARKET', status: 'FILLED' });
    expect(
      (await context.sql.query('SELECT status FROM orders WHERE id=$1', [partial.order!.id])).rows,
    ).toEqual([{ status: 'PARTIALLY_FILLED' }]);
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
    await exchange.close();
    exchange = undefined;

    const historyTables = [
      'exchange_sessions',
      'session_rollovers',
      'accounts',
      'users',
      'login_sessions',
      'invitations',
      'recovery_tokens',
      'allocations',
      'balances',
      'orders',
      'fills',
      'grants',
      'journal_transactions',
      'journal_entries',
      'receipts',
      'outbox',
      'admin_audit',
      'demo_market',
      'market_previews',
      'market_preview_uses',
    ];
    async function evidence() {
      const result: Record<string, string[]> = {};
      for (const table of historyTables) {
        // PostgreSQL renders exact numeric values and microsecond timestamps;
        // pg's Date conversion would discard part of the existing evidence.
        const rows = await context.sql.query<{ row: string }>(
          `SELECT row_to_json(t)::text AS row FROM ${table} t ORDER BY row_to_json(t)::text`,
        );
        result[table] = rows.rows.map(({ row }) => row);
      }
      result.control = (
        await context.sql.query<{ row: string }>(
          "SELECT (to_jsonb(t) - 'writer_epoch')::text AS row FROM exchange_control t",
        )
      ).rows.map(({ row }) => row);
      return result;
    }
    const originalEvidence = await evidence();
    const originalVersions = await context.sql.query<{ row: string }>(
      'SELECT row_to_json(t)::text AS row FROM schema_migrations t ORDER BY name',
    );
    await expect(Exchange.open(context.url, { migrations: 'verify' })).rejects.toMatchObject({
      code: 'MIGRATION_REQUIRED',
    });
    expect(await evidence()).toEqual(originalEvidence);
    exchange = await Exchange.open(context.url);
    expect(
      (await context.sql.query('SELECT name FROM schema_migrations ORDER BY name')).rows,
    ).toEqual([
      ...legacyMigrations.map(([name]) => ({ name })),
      { name: '008_order_integrity' },
      { name: '009_large_session_reads' },
    ]);
    expect(
      (
        await context.sql.query<{ row: string }>(
          "SELECT row_to_json(t)::text AS row FROM schema_migrations t WHERE name <= '007_command_timestamps' ORDER BY name",
        )
      ).rows,
    ).toEqual(originalVersions.rows);
    expect(await evidence()).toEqual(originalEvidence);

    // The new database guard applies to already accepted partial, open,
    // filled, canceled and protected market orders, not just future inserts.
    for (const id of [
      partial.order!.id,
      open.order!.id,
      filled.order!.id,
      canceled.order!.id,
      market.order!.id,
    ]) {
      await expect(
        context.sql.query(
          "UPDATE orders SET created_at=created_at + interval '1 second' WHERE id=$1",
          [id],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(context.sql.query('DELETE FROM orders WHERE id=$1', [id])).rejects.toMatchObject(
        {
          code: '23514',
        },
      );
    }
    expect(await evidence()).toEqual(originalEvidence);
    expect(await exchange.placeLimit(originalBuy)).toEqual(filled);
    expect(await exchange.cancel(originalCancel)).toEqual(canceled);
    expect(await exchange.placeMarket(originalMarket)).toEqual(market);
    expect(await evidence()).toEqual(originalEvidence);

    // Continue legitimate state transitions on the same pre-upgrade orders.
    const finish = await exchange.placeLimit({
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      side: 'BUY',
      quantity: '0.15',
      price: '50000',
    });
    expect(finish.order?.status).toBe('FILLED');
    expect(
      (await context.sql.query('SELECT status FROM orders WHERE id=$1', [partial.order!.id])).rows,
    ).toEqual([{ status: 'FILLED' }]);
    const cancelOpen = {
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      orderId: open.order!.id,
    };
    const canceledOpen = await exchange.cancel(cancelOpen);
    expect(canceledOpen.order).toMatchObject({ status: 'CANCELED', reserved: '0.0000' });
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
    const recoveredEvidence = await evidence();
    await exchange.close();
    exchange = await Exchange.open(context.url, { migrations: 'verify' });
    expect(await exchange.placeLimit(originalBuy)).toEqual(filled);
    expect(await exchange.cancel(originalCancel)).toEqual(canceled);
    expect(await exchange.placeMarket(originalMarket)).toEqual(market);
    expect(await exchange.cancel(cancelOpen)).toEqual(canceledOpen);
    expect(await evidence()).toEqual(recoveredEvidence);
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
  } finally {
    await exchange?.close();
    await context.dispose();
  }
});
