import { sql, type Kysely } from 'kysely';
import { INITIAL_SCHEMA } from './schema.js';
import { IDENTITY_SCHEMA } from './identity-schema.js';
import { DEMO_MARKET_SCHEMA } from './demo-market-schema.js';
import { SIMULATOR_CONTROLS_SCHEMA } from './simulator-controls-schema.js';
import { MARKET_ORDERS_SCHEMA } from './market-orders-schema.js';
import { SESSION_LIFECYCLE_SCHEMA } from './session-lifecycle-schema.js';
import { COMMAND_TIMESTAMP_SCHEMA } from './command-timestamp-schema.js';
import type { Database } from './types.js';

const migrations = [
  { name: '001_exchange_core', statement: INITIAL_SCHEMA },
  { name: '002_identity_and_controls', statement: IDENTITY_SCHEMA },
  { name: '003_demo_market', statement: DEMO_MARKET_SCHEMA },
  { name: '004_simulator_controls', statement: SIMULATOR_CONTROLS_SCHEMA },
  { name: '005_market_orders', statement: MARKET_ORDERS_SCHEMA },
  { name: '006_session_lifecycle', statement: SESSION_LIFECYCLE_SCHEMA },
  { name: '007_command_timestamps', statement: COMMAND_TIMESTAMP_SCHEMA },
];

/** Restricted runtime connections inspect versions without owning any DDL privileges. */
export async function verifyMigrations(database: Kysely<Database>): Promise<void> {
  const applied = await database.selectFrom('schema_migrations').select('name').execute();
  const names = new Set(applied.map(({ name }) => name));
  if (names.size !== migrations.length || migrations.some(({ name }) => !names.has(name)))
    throw Object.assign(new Error('Run the owner migration command before starting the API.'), {
      code: 'MIGRATION_REQUIRED',
    });
}

/** Migrations and their metadata commit together, under a transaction-held lock. */
export async function migrate(database: Kysely<Database>): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(482901, 1)`.execute(transaction);
    await sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default current_timestamp
      )
    `.execute(transaction);
    const applied = await transaction.selectFrom('schema_migrations').select('name').execute();
    const names = new Set(applied.map(({ name }) => name));
    for (const name of names) {
      if (!migrations.some((migration) => migration.name === name)) {
        throw new Error(`Database has unsupported migration: ${name}`);
      }
    }
    for (const migration of migrations) {
      if (!names.has(migration.name)) {
        await sql.raw(migration.statement).execute(transaction);
        await transaction
          .insertInto('schema_migrations')
          .values({ name: migration.name })
          .execute();
      }
    }
  });
}
