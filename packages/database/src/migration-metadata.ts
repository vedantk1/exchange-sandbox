import { sql, type Kysely } from 'kysely';
import type { Database } from './types.js';
import { migrationError } from './migration-registry.js';

interface MetadataColumn {
  name: string;
  type: string;
  not_null: boolean;
  identity: string;
  generated: string;
  default_value: string | null;
}

/** The version marker cannot disguise a malformed or partially upgraded metadata protocol. */
export async function verifyMetadataShape(
  database: Kysely<Database>,
  checksummed: boolean,
  protocolComplete: boolean,
): Promise<void> {
  const relation = await sql<{ canonical: boolean }>`
    select c.relkind = 'r' and c.relpersistence = 'p' and not c.relispartition
      and not c.relrowsecurity and not c.relforcerowsecurity and not exists (
      select 1 from pg_inherits i where i.inhrelid = c.oid or i.inhparent = c.oid
    ) and not exists (
      select 1 from pg_policy p where p.polrelid = c.oid
    ) as canonical from pg_class c where c.oid = to_regclass('schema_migrations')
  `.execute(database);
  const columns = await sql<MetadataColumn>`
    select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
      a.attnotnull as not_null, a.attidentity as identity, a.attgenerated as generated,
      pg_get_expr(d.adbin, d.adrelid, false) as default_value
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = to_regclass('schema_migrations') and a.attnum > 0 and not a.attisdropped
    order by a.attnum
  `.execute(database);
  const expected: MetadataColumn[] = [
    {
      name: 'name',
      type: 'text',
      not_null: true,
      identity: '',
      generated: '',
      default_value: null,
    },
    {
      name: 'applied_at',
      type: 'timestamp with time zone',
      not_null: true,
      identity: '',
      generated: '',
      default_value: 'CURRENT_TIMESTAMP',
    },
  ];
  if (checksummed)
    expected.push(
      {
        name: 'checksum',
        type: 'text',
        not_null: protocolComplete,
        identity: '',
        generated: '',
        default_value: null,
      },
      {
        name: 'checksum_origin',
        type: 'text',
        not_null: protocolComplete,
        identity: '',
        generated: '',
        default_value: null,
      },
      {
        name: 'verified_at',
        type: 'timestamp with time zone',
        not_null: protocolComplete,
        identity: '',
        generated: '',
        default_value: null,
      },
    );
  const constraints = await sql<{ name: string; definition: string; validated: boolean }>`
    select conname as name, pg_get_constraintdef(oid, false) as definition, convalidated as validated
    from pg_constraint where conrelid = to_regclass('schema_migrations')
      and contype <> 'n' order by conname
  `.execute(database);
  const expectedConstraints = [
    { name: 'schema_migrations_pkey', definition: 'PRIMARY KEY (name)', validated: true },
  ];
  if (protocolComplete)
    expectedConstraints.push(
      {
        name: 'migration_checksum_format',
        definition: "CHECK ((checksum ~ '^[0-9a-f]{64}$'::text))",
        validated: true,
      },
      {
        name: 'migration_checksum_origin',
        definition:
          "CHECK ((checksum_origin = ANY (ARRAY['APPLIED'::text, 'LEGACY_SCHEMA_VERIFIED'::text])))",
        validated: true,
      },
    );
  expectedConstraints.sort((left, right) => left.name.localeCompare(right.name));
  if (
    !relation.rows[0]?.canonical ||
    (protocolComplete && !checksummed) ||
    JSON.stringify(columns.rows) !== JSON.stringify(expected) ||
    JSON.stringify(constraints.rows) !== JSON.stringify(expectedConstraints)
  )
    throw migrationError(
      'MIGRATION_METADATA_INVALID',
      'Migration metadata structure does not match its declared protocol.',
    );
}
