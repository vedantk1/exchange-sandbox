import pg from 'pg';
import {
  createDatabase,
  migrate,
  verifyMigrations,
  withDatabaseBudget,
  DatabaseTimeoutError,
  type MigrationOptions,
} from '@sandbox/database';
import { provisionRuntimeRole } from './runtime-role.js';
import { Exchange } from '../exchange.js';

/** Owner maintenance obeys writer ownership and finite SQL/transport budgets. */
async function initialize(
  ownerUrl: string,
  runtimeUrl: URL | undefined,
  options: MigrationOptions,
): Promise<void> {
  const owner = new pg.Client({
    connectionString: ownerUrl,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 60_000,
    lock_timeout: 2_000,
    idle_in_transaction_session_timeout: 120_000,
    keepAlive: true,
  });
  // Consume active connection errors while the associated query rejects.
  owner.on('error', () => undefined);
  const database = createDatabase(ownerUrl);
  let databaseClosing: Promise<void> | undefined;
  const closeDatabase = () => (databaseClosing ??= database.destroy());
  let expired = false;
  const originalQuery = owner.query.bind(owner);
  // This internal owner client uses only pg's promise-based text/values API.
  owner.query = (async (text: string, parameters?: unknown[]) => {
    if (expired) throw new DatabaseTimeoutError('maintenance');
    return originalQuery(text, parameters);
  }) as pg.Client['query'];
  const ownerDeadline = setTimeout(() => {
    expired = true;
    // Keep ownership while old managed migration transports drain/discard.
    // Once disposed, disconnect owner SQL so it cannot send a late COMMIT.
    void closeDatabase().then(
      () => {
        void owner.end().catch(() => undefined);
        owner.connection.stream.destroy();
      },
      () => {
        // Preserve the owner guard if managed cleanup is not confirmed; the
        // final process watchdog remains responsible for closing all sockets.
      },
    );
  }, 120_000);
  const processDeadline = setTimeout(() => {
    console.error(
      'Owner initialization exceeded its maintenance deadline; inspect migration state.',
    );
    process.exit(1);
  }, 145_000);
  try {
    await owner.connect();
    const locked = await owner.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [7_314_921],
    );
    if (!locked.rows[0]?.acquired)
      throw Object.assign(new Error('Stop the API before migrating.'), {
        code: 'OWNER_WRITER_BUSY',
      });
    await withDatabaseBudget(database, 'maintenance', async () => {
      await migrate(database, options);
      await verifyMigrations(database);
    });
    await owner.query("SELECT set_config('transaction_timeout', '120000ms', false)");
    if (runtimeUrl)
      await provisionRuntimeRole(
        owner,
        decodeURIComponent(runtimeUrl.password),
        decodeURIComponent(runtimeUrl.username),
      );
    await closeDatabase();
    await owner.query('SELECT pg_advisory_unlock($1)', [7_314_921]);
    if (runtimeUrl) {
      const runtime = await Exchange.open(runtimeUrl.toString(), {
        migrations: 'verify',
        allowFaultedStartup: true,
      });
      await runtime.close();
    }
  } finally {
    try {
      await closeDatabase();
    } catch {
      console.error('Owner cleanup could not be confirmed; restart to inspect migration state.');
      // Do not separately release ownership if old migration transports have
      // not been disposed. Exit closes all process sockets together.
      process.exit(1);
    }
    const closeDeadline = setTimeout(() => owner.connection.stream.destroy(), 5_000);
    try {
      await owner.end();
    } finally {
      clearTimeout(closeDeadline);
      clearTimeout(ownerDeadline);
      clearTimeout(processDeadline);
    }
  }
}

/** Self-host owner migration and restricted-role provisioning. */
export function initializeOwner(
  ownerUrl: string,
  runtimeUrl: URL,
  options: MigrationOptions = {},
): Promise<void> {
  return initialize(ownerUrl, runtimeUrl, options);
}

/** Development/owner CLI: the same ownership and deadline boundary, without changing roles. */
export function migrateOwner(ownerUrl: string, options: MigrationOptions = {}): Promise<void> {
  return initialize(ownerUrl, undefined, options);
}
