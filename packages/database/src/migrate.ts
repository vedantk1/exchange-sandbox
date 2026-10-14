import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from './types.js';
import {
  MIGRATIONS,
  migrationError,
  verifyMigrationNames,
  verifyMigrationSources,
} from './migration-registry.js';
import { attestLegacySchema } from './schema-attestation.js';
import { verifyMetadataShape } from './migration-metadata.js';

export interface MigrationOptions {
  /** Explicit owner attestation of this exact names-only historical prefix. */
  legacyBaseline?: string;
}

interface MigrationRecord {
  name: string;
  checksum: string | null;
  checksum_origin: 'APPLIED' | 'LEGACY_SCHEMA_VERIFIED' | null;
  verified_at: Date | null;
}

const checksumColumns = ['checksum', 'checksum_origin', 'verified_at'];

async function metadataColumns(database: Kysely<Database>): Promise<Set<string>> {
  const result = await sql<{ name: string }>`
    select attname as name from pg_attribute
    where attrelid = to_regclass('schema_migrations') and attnum > 0 and not attisdropped
  `.execute(database);
  return new Set(result.rows.map(({ name }) => name));
}

function verifyRecords(records: readonly MigrationRecord[]): void {
  const expected = new Map(MIGRATIONS.map((migration) => [migration.name, migration.checksum]));
  for (const record of records) {
    if (record.checksum !== expected.get(record.name))
      throw migrationError(
        'MIGRATION_CHECKSUM_MISMATCH',
        `Stored migration checksum does not match the pinned SQL: ${record.name}`,
      );
    if (
      !['APPLIED', 'LEGACY_SCHEMA_VERIFIED'].includes(record.checksum_origin ?? '') ||
      !(record.verified_at instanceof Date) ||
      Number.isNaN(record.verified_at.getTime())
    )
      throw migrationError(
        'MIGRATION_METADATA_INVALID',
        `Migration verification provenance is missing or invalid: ${record.name}`,
      );
  }
  const adopted = records
    .filter(({ checksum_origin }) => checksum_origin === 'LEGACY_SCHEMA_VERIFIED')
    .map(({ name }) => name)
    .sort();
  const lastLegacy = MIGRATIONS.findIndex(({ name }) => name === '009_large_session_reads') + 1;
  if (
    adopted.length > lastLegacy ||
    adopted.some((name, index) => name !== MIGRATIONS[index]?.name)
  )
    throw migrationError(
      'MIGRATION_METADATA_INVALID',
      'Legacy verification provenance is not a canonical historical prefix.',
    );
}

function legacyBaselineCount(options: MigrationOptions): number | undefined {
  if (options.legacyBaseline === undefined) return undefined;
  const index = MIGRATIONS.findIndex(({ name }) => name === options.legacyBaseline);
  const lastLegacy = MIGRATIONS.findIndex(({ name }) => name === '009_large_session_reads');
  if (index < 0 || index > lastLegacy)
    throw migrationError(
      'MIGRATION_LEGACY_BASELINE_MISMATCH',
      'The legacy baseline must identify a known migration from 001 through 009.',
    );
  return index + 1;
}

function verifyAdoptionRetry(records: readonly MigrationRecord[], baselineCount: number): void {
  const adopted = records.filter(
    ({ checksum_origin }) => checksum_origin === 'LEGACY_SCHEMA_VERIFIED',
  );
  const count = verifyMigrationNames(adopted.map(({ name }) => name));
  if (count !== baselineCount)
    throw migrationError(
      'MIGRATION_LEGACY_BASELINE_MISMATCH',
      'The requested legacy baseline does not match the previously attested migration prefix.',
    );
}

/** Restricted runtime connections inspect versions/checksums without DDL privileges. */
export async function verifyMigrations(database: Kysely<Database>): Promise<void> {
  verifyMigrationSources();
  const columns = await metadataColumns(database);
  if (!columns.has('name'))
    throw migrationError(
      'MIGRATION_REQUIRED',
      'Run the owner migration command before starting the API.',
    );
  const applied = await database.selectFrom('schema_migrations').select('name').execute();
  const count = verifyMigrationNames(applied.map(({ name }) => name));
  await verifyMetadataShape(
    database,
    checksumColumns.every((column) => columns.has(column)),
    applied.some(({ name }) => name === '010_migration_checksums'),
  );
  if (!checksumColumns.every((column) => columns.has(column)))
    throw migrationError(
      'MIGRATION_ADOPTION_REQUIRED',
      'Names-only migration history requires explicit owner schema attestation before starting the API.',
    );
  const records = await database
    .selectFrom('schema_migrations')
    .select(['name', 'checksum', 'checksum_origin', 'verified_at'])
    .execute();
  verifyRecords(records);
  if (count !== MIGRATIONS.length)
    throw migrationError(
      'MIGRATION_REQUIRED',
      'Run the owner migration command before starting the API.',
    );
}

async function prepareMetadata(
  transaction: Transaction<Database>,
  baselineCount: number | undefined,
): Promise<number> {
  const columns = await metadataColumns(transaction);
  if (!columns.has('name')) {
    if (baselineCount !== undefined)
      throw migrationError(
        'MIGRATION_LEGACY_BASELINE_MISMATCH',
        'No legacy migration history exists.',
      );
    await sql`
      create table schema_migrations (
        name text primary key,
        applied_at timestamptz not null default current_timestamp,
        checksum text,
        checksum_origin text,
        verified_at timestamptz
      )
    `.execute(transaction);
    return 0;
  }
  const applied = await transaction.selectFrom('schema_migrations').select('name').execute();
  const count = verifyMigrationNames(applied.map(({ name }) => name));
  const present = checksumColumns.filter((column) => columns.has(column)).length;
  await verifyMetadataShape(
    transaction,
    present === checksumColumns.length,
    applied.some(({ name }) => name === '010_migration_checksums'),
  );
  if (present === checksumColumns.length) {
    const records = await transaction
      .selectFrom('schema_migrations')
      .select(['name', 'checksum', 'checksum_origin', 'verified_at'])
      .execute();
    verifyRecords(records);
    if (baselineCount !== undefined) verifyAdoptionRetry(records, baselineCount);
    return count;
  }
  if (present > 0)
    throw migrationError(
      'MIGRATION_METADATA_INVALID',
      'Migration checksum metadata is incomplete.',
    );
  if (count > 0) {
    if (baselineCount === undefined)
      throw migrationError(
        'MIGRATION_ADOPTION_REQUIRED',
        'Names-only migration history requires explicit owner schema attestation; no changes were made.',
      );
    if (baselineCount !== count)
      throw migrationError(
        'MIGRATION_LEGACY_BASELINE_MISMATCH',
        'The requested legacy baseline does not match the installed migration prefix.',
      );
    await attestLegacySchema(transaction, count);
  } else if (baselineCount !== undefined) {
    throw migrationError(
      'MIGRATION_LEGACY_BASELINE_MISMATCH',
      'The legacy migration history is empty.',
    );
  }
  // Names, provenance and structure are validated before metadata or application DDL.
  await sql`
    alter table schema_migrations add column checksum text,
      add column checksum_origin text, add column verified_at timestamptz
  `.execute(transaction);
  for (const migration of MIGRATIONS.slice(0, count)) {
    await transaction
      .updateTable('schema_migrations')
      .set({
        checksum: migration.checksum,
        checksum_origin: 'LEGACY_SCHEMA_VERIFIED',
        verified_at: sql<Date>`current_timestamp`,
      })
      .where('name', '=', migration.name)
      .execute();
  }
  return count;
}

/** SQL, checksum adoption and metadata commit atomically under a transaction-held lock. */
export async function migrate(
  database: Kysely<Database>,
  options: MigrationOptions = {},
): Promise<void> {
  verifyMigrationSources();
  const baselineCount = legacyBaselineCount(options);
  await database.transaction().execute(async (transaction) => {
    await sql`select pg_advisory_xact_lock(482901, 1)`.execute(transaction);
    const count = await prepareMetadata(transaction, baselineCount);
    for (const migration of MIGRATIONS.slice(count)) {
      await sql.raw(migration.statement).execute(transaction);
      await transaction
        .insertInto('schema_migrations')
        .values({
          name: migration.name,
          checksum: migration.checksum,
          checksum_origin: 'APPLIED',
          verified_at: sql<Date>`current_timestamp`,
        })
        .execute();
    }
  });
}
