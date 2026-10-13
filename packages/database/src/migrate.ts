import { sql, type Kysely } from 'kysely';
import { INITIAL_SCHEMA } from './schema.js';
import { IDENTITY_SCHEMA } from './identity-schema.js';
import { DEMO_MARKET_SCHEMA } from './demo-market-schema.js';
import { SIMULATOR_CONTROLS_SCHEMA } from './simulator-controls-schema.js';
import { MARKET_ORDERS_SCHEMA } from './market-orders-schema.js';
import type { Database } from './types.js';

const migrations = [
  { name: '001_exchange_core', statement: INITIAL_SCHEMA },
  { name: '002_identity_and_controls', statement: IDENTITY_SCHEMA },
  { name: '003_demo_market', statement: DEMO_MARKET_SCHEMA },
  { name: '004_simulator_controls', statement: SIMULATOR_CONTROLS_SCHEMA },
  { name: '005_market_orders', statement: MARKET_ORDERS_SCHEMA },
];

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
