import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { AuthService } from '../../apps/server/src/auth/index.js';
import { allocateTrader, initializeSession } from '../../apps/server/src/core-mutations.js';
import { Exchange } from '../../apps/server/src/exchange.js';
import { createDatabase } from '../../packages/database/src/index.js';
import { INITIAL_SCHEMA } from '../../packages/database/src/schema.js';
import { TEST_PASSWORD } from '../helpers/api.js';
import { createUpgradeDatabase } from '../helpers/api-upgrade.js';

it('upgrades a committed milestone-one installation without changing its accounting history', async () => {
  const context = await createUpgradeDatabase();
  const legacy = createDatabase(context.url);
  let exchange: Exchange | undefined;
  try {
    // Apply the original migration directly, rather than creating a current
    // database and merely deleting its migration marker.
    const connection = await context.sql.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(INITIAL_SCHEMA);
      await connection.query(`CREATE TABLE schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`);
      await connection.query('INSERT INTO schema_migrations (name) VALUES ($1)', [
        '001_exchange_core',
      ]);
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }

    const accountId = randomUUID();
    const commandId = randomUUID();
    const setup = await legacy.transaction().execute(async (transaction) => {
      const setup = await initializeSession(transaction, { marketState: 'TRADING' });
      await transaction
        .insertInto('accounts')
        .values({ id: accountId, kind: 'TRADER', label: 'legacy_trader' })
        .execute();
      await allocateTrader(transaction, setup.sessionId, accountId, commandId);
      return setup;
    });
    const original = await context.sql.query(`
      SELECT id, session_id, command_id, kind, created_at FROM journal_transactions ORDER BY id
    `);
    const originalBalances = await context.sql.query(`
      SELECT * FROM balances ORDER BY account_id, asset, bucket
    `);
    expect((await context.sql.query("SELECT to_regclass('users') AS identity_table")).rows).toEqual(
      [{ identity_table: null }],
    );

    exchange = await Exchange.open(context.url);
    expect(
      (await context.sql.query('SELECT name FROM schema_migrations ORDER BY name')).rows,
    ).toEqual([
      { name: '001_exchange_core' },
      { name: '002_identity_and_controls' },
      { name: '003_demo_market' },
      { name: '004_simulator_controls' },
      { name: '005_market_orders' },
      { name: '006_session_lifecycle' },
    ]);
    expect((await context.sql.query('SELECT session_id FROM demo_market')).rows).toEqual([]);
    const snapshot = await exchange.snapshot(accountId);
    expect(snapshot.sessionId).toBe(setup.sessionId);
    expect(snapshot.balances).toEqual({
      'BTC-SIM': { available: '1.0000', reserved: '0.0000', total: '1.0000' },
      'USD-SIM': {
        available: '100000.000000000',
        reserved: '0.000000000',
        total: '100000.000000000',
      },
    });
    expect(
      (await context.sql.query('SELECT * FROM balances ORDER BY account_id, asset, bucket')).rows,
    ).toEqual(originalBalances.rows);
    expect(
      (
        await context.sql.query(
          'SELECT id, session_id, command_id, kind, created_at FROM journal_transactions ORDER BY id',
        )
      ).rows,
    ).toEqual(original.rows);

    const auth = new AuthService(exchange);
    const administrator = await auth.bootstrapAdmin({
      handle: 'operator',
      password: TEST_PASSWORD,
    });
    expect(administrator.sessionId).toBe(setup.sessionId);
    expect((await context.sql.query('SELECT market_state FROM exchange_control')).rows).toEqual([
      { market_state: 'PAUSED' },
    ]);
    expect(
      (
        await context.sql.query(
          'SELECT count(*)::integer AS count FROM balances WHERE account_id = $1',
          [administrator.accountId],
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (await context.sql.query('SELECT account_id, session_id, command_id FROM allocations')).rows,
    ).toEqual([{ account_id: accountId, session_id: setup.sessionId, command_id: commandId }]);
    expect(await exchange.snapshot(accountId)).toEqual(snapshot);
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
  } finally {
    await exchange?.close();
    await legacy.destroy();
    await context.dispose();
  }
});
