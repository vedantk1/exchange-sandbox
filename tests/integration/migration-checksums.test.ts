import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDatabase,
  migrate,
  verifyMigrations,
  withDatabaseBudget,
} from '../../packages/database/src/index.js';
import {
  MIGRATIONS,
  verifyMigrationNames,
  verifyMigrationSources,
} from '../../packages/database/src/migration-registry.js';
import { INITIAL_SCHEMA } from '../../packages/database/src/schema.js';
import { COMMAND_TIMESTAMP_SCHEMA } from '../../packages/database/src/command-timestamp-schema.js';
import { normalizeSchemaQualifiers } from '../../packages/database/src/schema-qualifiers.js';
import pg from 'pg';
import { createUpgradeDatabase } from '../helpers/api-upgrade.js';

type UpgradeDatabase = Awaited<ReturnType<typeof createUpgradeDatabase>>;

describe('migration checksum and legacy adoption boundaries', () => {
  let context: UpgradeDatabase;
  let database: ReturnType<typeof createDatabase>;

  beforeEach(async () => {
    context = await createUpgradeDatabase();
    database = createDatabase(context.url);
  });

  afterEach(async () => {
    vi.doUnmock('../../packages/database/src/schema.js');
    vi.resetModules();
    await database?.destroy();
    await context?.dispose();
  });

  const apply = (database: ReturnType<typeof createDatabase>, legacyBaseline?: string) =>
    withDatabaseBudget(database, 'maintenance', () =>
      migrate(database, legacyBaseline === undefined ? {} : { legacyBaseline }),
    );

  async function legacy(count = 9, pool = context.sql): Promise<void> {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(`CREATE TABLE schema_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT current_timestamp
      )`);
      for (const migration of MIGRATIONS.slice(0, count)) {
        await connection.query(migration.statement);
        await connection.query(
          `INSERT INTO schema_migrations (name, applied_at)
            VALUES ($1, '2026-01-02 03:04:05.123456+00')`,
          [migration.name],
        );
      }
      await connection.query('COMMIT');
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      connection.release();
    }
  }

  async function metadata(): Promise<string[]> {
    return (
      await context.sql.query<{ row: string }>(
        'SELECT row_to_json(t)::text AS row FROM schema_migrations t ORDER BY name',
      )
    ).rows.map(({ row }) => row);
  }

  it('pins exact published SQL and rejects edited source before opening a fresh transaction', async () => {
    expect(() => verifyMigrationSources()).not.toThrow();
    const changed = MIGRATIONS.map((migration, index) =>
      index === 0 ? { ...migration, statement: `${migration.statement}\n` } : migration,
    );
    expect(() => verifyMigrationSources(changed)).toThrow('pinned checksum');
    // Exercise the actual migrate entry point with a changed source import,
    // including a whitespace-only edit, rather than mocking its validator.
    vi.doMock('../../packages/database/src/schema.js', () => ({
      INITIAL_SCHEMA: `${INITIAL_SCHEMA}\n`,
    }));
    vi.resetModules();
    const changedModule = await import('../../packages/database/src/migrate.js');
    const transaction = vi.fn();
    await expect(
      changedModule.migrate({ transaction } as unknown as ReturnType<typeof createDatabase>),
    ).rejects.toMatchObject({ code: 'MIGRATION_SOURCE_MISMATCH' });
    expect(transaction).not.toHaveBeenCalled();
    expect(
      (await context.sql.query("SELECT to_regclass('schema_migrations') AS relation")).rows,
    ).toEqual([{ relation: null }]);
  });

  it('normalizes namespace identifiers while preserving SQL literals, comments and dollar-quoted bodies', () => {
    const statement = `CREATE FUNCTION exchange.f() RETURNS text AS $body$ SELECT 'exchange.command_timestamp'; $body$ LANGUAGE sql;
      SELECT exchange.f(), "exchange".f(), 'exchange.f()', E'exchange.f()\\\'quoted';
      -- exchange.f()
      /* exchange.f() /* exchange.f() */ */`;
    expect(normalizeSchemaQualifiers(statement, 'exchange')).toBe(
      statement
        .replace('FUNCTION exchange.f()', 'FUNCTION <schema>.f()')
        .replace('SELECT exchange.f(), "exchange".f()', 'SELECT <schema>.f(), <schema>.f()'),
    );
    expect(normalizeSchemaQualifiers('CREATE FUNCTION "a""b c".f()', 'a"b c')).toBe(
      'CREATE FUNCTION <schema>.f()',
    );
  });

  it('records exact checksums with applied provenance on a fresh install and serializes concurrent retries', async () => {
    await Promise.all([apply(database), apply(database)]);
    await verifyMigrations(database);
    const rows = (await context.sql.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    expect(rows).toHaveLength(10);
    expect(
      rows.map(({ name, checksum, checksum_origin }) => ({ name, checksum, checksum_origin })),
    ).toEqual(
      MIGRATIONS.map(({ name, checksum }) => ({ name, checksum, checksum_origin: 'APPLIED' })),
    );
    expect(
      rows.every(
        ({ verified_at, applied_at }) => verified_at instanceof Date && applied_at instanceof Date,
      ),
    ).toBe(true);
    const original = await metadata();
    await apply(database);
    expect(await metadata()).toEqual(original);
    await expect(apply(database, '009_large_session_reads')).rejects.toMatchObject({
      code: 'MIGRATION_LEGACY_BASELINE_MISMATCH',
    });
  });

  it('requires explicit adoption, preserves historical timestamps and makes a lost-reply retry idempotent', async () => {
    await legacy();
    const original = await metadata();
    await expect(apply(database)).rejects.toMatchObject({ code: 'MIGRATION_ADOPTION_REQUIRED' });
    await expect(verifyMigrations(database)).rejects.toMatchObject({
      code: 'MIGRATION_ADOPTION_REQUIRED',
    });
    await expect(apply(database, '008_order_integrity')).rejects.toMatchObject({
      code: 'MIGRATION_LEGACY_BASELINE_MISMATCH',
    });
    expect(await metadata()).toEqual(original);
    await apply(database, '009_large_session_reads');
    await verifyMigrations(database);
    const records = (await context.sql.query('SELECT * FROM schema_migrations ORDER BY name')).rows;
    expect(records.slice(0, 9).map(({ checksum_origin }) => checksum_origin)).toEqual(
      Array(9).fill('LEGACY_SCHEMA_VERIFIED'),
    );
    expect(records[9]!.checksum_origin).toBe('APPLIED');
    expect(
      (
        await context.sql.query<{ row: string }>(
          "SELECT row_to_json(t)::text AS row FROM (SELECT name, applied_at FROM schema_migrations WHERE name < '010') t ORDER BY name",
        )
      ).rows.map(({ row }) => row),
    ).toEqual(original);
    const committed = await metadata();
    await database.destroy();
    database = createDatabase(context.url);
    await apply(database, '009_large_session_reads');
    expect(await metadata()).toEqual(committed);
    await expect(apply(database, '008_order_integrity')).rejects.toMatchObject({
      code: 'MIGRATION_LEGACY_BASELINE_MISMATCH',
    });
    expect(await metadata()).toEqual(committed);
    // A historical names-only runtime expects exactly nine names and is fenced
    // by the new protocol marker, even though its SQL never reads hash columns.
    expect(records.map(({ name }) => name)).not.toEqual(
      MIGRATIONS.slice(0, 9).map(({ name }) => name),
    );
  });

  it.each([
    ['unknown', ['001_exchange_core', '999_future_schema']],
    ['gap', ['001_exchange_core', '003_demo_market']],
    ['missing first', ['002_identity_and_controls']],
  ])('rejects %s history before metadata or application DDL', async (_label, names) => {
    await context.sql.query(
      'CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT current_timestamp)',
    );
    for (const name of names)
      await context.sql.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
    const original = await metadata();
    await expect(apply(database)).rejects.toMatchObject({ code: 'MIGRATION_HISTORY_INVALID' });
    await expect(apply(database, '001_exchange_core')).rejects.toMatchObject({
      code: 'MIGRATION_HISTORY_INVALID',
    });
    expect(await metadata()).toEqual(original);
    expect(
      (await context.sql.query("SELECT to_regclass('exchange_sessions') AS relation")).rows,
    ).toEqual([{ relation: null }]);
    expect(
      (
        await context.sql.query(
          "SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid='schema_migrations'::regclass AND attname='checksum'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(() => verifyMigrationNames(names)).toThrow();
  });

  it('rejects a changed stored checksum at owner and runtime entry points without rewriting it', async () => {
    await apply(database);
    await context.sql.query(
      "UPDATE schema_migrations SET checksum=repeat('0',64) WHERE name='001_exchange_core'",
    );
    const original = await metadata();
    await expect(apply(database)).rejects.toMatchObject({ code: 'MIGRATION_CHECKSUM_MISMATCH' });
    await expect(verifyMigrations(database)).rejects.toMatchObject({
      code: 'MIGRATION_CHECKSUM_MISMATCH',
    });
    expect(await metadata()).toEqual(original);
  });

  it.each([
    [
      'timestamp type',
      'ALTER TABLE schema_migrations ALTER COLUMN verified_at TYPE text USING verified_at::text',
    ],
    ['checksum type', 'ALTER TABLE schema_migrations ALTER COLUMN checksum TYPE varchar(64)'],
    ['nullability', 'ALTER TABLE schema_migrations ALTER COLUMN applied_at DROP NOT NULL'],
    [
      'missing format constraint',
      'ALTER TABLE schema_migrations DROP CONSTRAINT migration_checksum_format',
    ],
    ['missing primary key', 'ALTER TABLE schema_migrations DROP CONSTRAINT schema_migrations_pkey'],
    ['row security', 'ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY'],
    [
      'nonprefix provenance',
      "UPDATE schema_migrations SET checksum_origin='LEGACY_SCHEMA_VERIFIED' WHERE name='005_market_orders'",
    ],
    [
      'protocol adoption provenance',
      "UPDATE schema_migrations SET checksum_origin='LEGACY_SCHEMA_VERIFIED' WHERE name='010_migration_checksums'",
    ],
  ])(
    'rejects %s metadata drift before treating the protocol marker as verified',
    async (_label, fault) => {
      await apply(database);
      await context.sql.query(fault);
      const original = await metadata();
      await expect(apply(database)).rejects.toMatchObject({ code: 'MIGRATION_METADATA_INVALID' });
      await expect(verifyMigrations(database)).rejects.toMatchObject({
        code: 'MIGRATION_METADATA_INVALID',
      });
      expect(await metadata()).toEqual(original);
    },
  );

  it('attests a schema named sandbox without rewriting a command-setting literal', async () => {
    // This legitimate namespace shares its name with the dotted literal inside
    // exchange_command_timestamp(); normalization must preserve that literal.
    await context.sql.query('CREATE SCHEMA sandbox');
    const url = new URL(context.url);
    url.searchParams.set('options', '-c search_path=sandbox');
    const pool = new pg.Pool({ connectionString: url.toString() });
    const owner = createDatabase(url.toString());
    try {
      await legacy(9, pool);
      await apply(owner, '009_large_session_reads');
      await verifyMigrations(owner);
    } finally {
      await owner.destroy();
      await pool.end();
      await context.sql.query('DROP SCHEMA sandbox CASCADE');
    }
  });

  it.each([
    ['disabled trigger', 'ALTER TABLE orders DISABLE TRIGGER immutable_order_terms'],
    [
      'changed function',
      `CREATE OR REPLACE FUNCTION protect_order_terms() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`,
    ],
    [
      'changed function literal',
      COMMAND_TIMESTAMP_SCHEMA.replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION').replaceAll(
        'sandbox.command_timestamp',
        'other.command_timestamp',
      ),
    ],
    ['missing index', 'DROP INDEX fills_by_minute'],
    ['changed default', 'ALTER TABLE orders ALTER COLUMN updated_at SET DEFAULT current_timestamp'],
    ['extra column', 'ALTER TABLE accounts ADD COLUMN undocumented text'],
    ['extra index', 'CREATE INDEX undocumented_orders ON orders (created_at)'],
    ['row security', 'ALTER TABLE balances ENABLE ROW LEVEL SECURITY'],
    [
      'changed check',
      'ALTER TABLE accounts DROP CONSTRAINT accounts_label_check; ALTER TABLE accounts ADD CONSTRAINT accounts_label_check CHECK (length(label) BETWEEN 1 AND 81)',
    ],
  ])('rejects %s schema drift before adopting any checksum', async (_label, fault) => {
    await legacy();
    await context.sql.query(fault);
    const original = await metadata();
    await expect(apply(database, '009_large_session_reads')).rejects.toMatchObject({
      code: 'MIGRATION_SCHEMA_MISMATCH',
    });
    expect(await metadata()).toEqual(original);
    expect(
      (
        await context.sql.query(
          "SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid='schema_migrations'::regclass AND attname='checksum'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await context.sql.query(
          "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'migration_attestation_%'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
  });

  it('rolls back new schema and checksum metadata together when fresh application DDL fails', async () => {
    await context.sql.query('CREATE TABLE orders (sentinel integer)');
    await expect(apply(database)).rejects.toMatchObject({ code: '42P07' });
    expect(
      (
        await context.sql.query(
          "SELECT to_regclass('schema_migrations') AS metadata, to_regclass('exchange_sessions') AS sessions",
        )
      ).rows,
    ).toEqual([{ metadata: null, sessions: null }]);
    expect(
      (
        await context.sql.query(
          "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='orders'",
        )
      ).rows,
    ).toEqual([{ column_name: 'sentinel' }]);
  });

  it('rejects inheritance from an empty external parent before adopting canonical schema provenance', async () => {
    await legacy();
    const parentSchema = `migration_parent_${randomUUID().replaceAll('-', '')}`;
    try {
      await context.sql.query(`CREATE SCHEMA "${parentSchema}"`);
      await context.sql.query(`CREATE TABLE "${parentSchema}".empty_parent ()`);
      await context.sql.query(`ALTER TABLE accounts INHERIT "${parentSchema}".empty_parent`);
      const original = await metadata();
      await expect(apply(database, '009_large_session_reads')).rejects.toMatchObject({
        code: 'MIGRATION_SCHEMA_MISMATCH',
      });
      expect(await metadata()).toEqual(original);
    } finally {
      await context.sql.query(`DROP SCHEMA "${parentSchema}" CASCADE`);
    }
  });

  it('rolls back attestation, provenance, new indexes and protocol constraints when recording a migration fails', async () => {
    await legacy(8);
    const original = await metadata();
    const faultSchema = `migration_fault_${randomUUID().replaceAll('-', '')}`;
    try {
      await context.sql.query(`CREATE SCHEMA "${faultSchema}"`);
      await context.sql.query(
        `CREATE FUNCTION "${faultSchema}".reject_protocol_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected migration recording failure'; END; $$`,
      );
      await context.sql.query(
        `CREATE TRIGGER injected_marker_failure BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION "${faultSchema}".reject_protocol_marker()`,
      );
      await expect(apply(database, '008_order_integrity')).rejects.toThrow(
        'injected migration recording failure',
      );
      expect(await metadata()).toEqual(original);
      expect(
        (await context.sql.query("SELECT to_regclass('fills_by_minute') AS index")).rows,
      ).toEqual([{ index: null }]);
      expect(
        (
          await context.sql.query(
            "SELECT count(*)::integer AS count FROM pg_attribute WHERE attrelid='schema_migrations'::regclass AND attname='checksum'",
          )
        ).rows,
      ).toEqual([{ count: 0 }]);
      await context.sql.query('DROP TRIGGER injected_marker_failure ON schema_migrations');
      await apply(database, '008_order_integrity');
      await verifyMigrations(database);
    } finally {
      await context.sql.query(`DROP SCHEMA "${faultSchema}" CASCADE`);
    }
  });
});
