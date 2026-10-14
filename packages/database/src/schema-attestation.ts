import { randomUUID } from 'node:crypto';
import { sql, type Transaction } from 'kysely';
import type { Database } from './types.js';
import { MIGRATIONS, migrationError } from './migration-registry.js';
import { normalizeSchemaQualifiers } from './schema-qualifiers.js';

/** Compare structures on the same PostgreSQL version; never fingerprint row data or ACLs. */
async function catalogFacts(transaction: Transaction<Database>, schema: string): Promise<string[]> {
  await sql`select set_config('search_path', ${`${quoteIdentifier(schema)}, pg_catalog`}, true)`.execute(
    transaction,
  );
  const result = await sql<{ fact: unknown[] }>`
    with namespace as (
      select oid from pg_namespace where nspname = ${schema}
    ), relations as (
      select c.* from pg_class c join namespace n on n.oid = c.relnamespace
      where c.relname <> 'schema_migrations' and c.relkind <> 'i'
    ), facts as (
      select jsonb_build_array('relation', c.relname, c.relkind, c.relpersistence,
        am.amname, c.relrowsecurity, c.relforcerowsecurity, c.relreplident,
        c.reloptions, case when c.relkind in ('v', 'm') then pg_get_viewdef(c.oid, false) end,
        c.relispartition, pg_get_expr(c.relpartbound, c.oid, false)) as fact
      from relations c left join pg_am am on am.oid = c.relam
      union all
      select jsonb_build_array('column', c.relname, a.attnum,
        case when a.attisdropped then '<dropped>' else a.attname end,
        case when not a.attisdropped then format_type(a.atttypid, a.atttypmod) end,
        a.attnotnull, a.attidentity, a.attgenerated, a.attisdropped,
        co.collname, pg_get_expr(d.adbin, d.adrelid, false), a.attislocal, a.attinhcount)
      from relations c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0
      left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
      left join pg_collation co on co.oid = a.attcollation
      union all
      select jsonb_build_array('inheritance', c.relname,
        case when parent.relnamespace = (select oid from namespace) then '<schema>'
          else parent_namespace.nspname end,
        parent.relname, i.inhseqno)
      from relations c join pg_inherits i on i.inhrelid = c.oid
      join pg_class parent on parent.oid = i.inhparent
      join pg_namespace parent_namespace on parent_namespace.oid = parent.relnamespace
      union all
      select jsonb_build_array('constraint', c.relname, k.conname, k.contype,
        k.condeferrable, k.condeferred, k.convalidated, pg_get_constraintdef(k.oid, false))
      from relations c join pg_constraint k on k.conrelid = c.oid
      union all
      select jsonb_build_array('index', c.relname, ic.relname,
        i.indisvalid, i.indisready, i.indislive, pg_get_indexdef(i.indexrelid))
      from relations c join pg_index i on i.indrelid = c.oid
      join pg_class ic on ic.oid = i.indexrelid
      union all
      select jsonb_build_array('trigger', c.relname, t.tgname, t.tgenabled,
        pg_get_triggerdef(t.oid, false))
      from relations c join pg_trigger t on t.tgrelid = c.oid and not t.tgisinternal
      union all
      select jsonb_build_array('function', p.proname, pg_get_function_identity_arguments(p.oid),
        pg_get_functiondef(p.oid))
      from pg_proc p join namespace n on n.oid = p.pronamespace
      union all
      select jsonb_build_array('sequence', c.relname, format_type(s.seqtypid, null),
        s.seqstart, s.seqincrement, s.seqmax, s.seqmin, s.seqcache, s.seqcycle,
        case when owner_class.relnamespace = (select oid from namespace) then '<schema>'
          else owner_namespace.nspname end,
        owner_class.relname, owner_column.attname, d.deptype)
      from relations c join pg_sequence s on s.seqrelid = c.oid
      left join pg_depend d on d.classid = 'pg_class'::regclass and d.objid = c.oid
        and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
      left join pg_class owner_class on owner_class.oid = d.refobjid
      left join pg_namespace owner_namespace on owner_namespace.oid = owner_class.relnamespace
      left join pg_attribute owner_column on owner_column.attrelid = d.refobjid
        and owner_column.attnum = d.refobjsubid
      union all
      select jsonb_build_array('type', t.typname, t.typtype, t.typcategory,
        case when t.typtype = 'd' then format_type(t.typbasetype, t.typtypmod) end,
        t.typnotnull, t.typdefault, e.enumlabel, e.enumsortorder)
      from pg_type t join namespace n on n.oid = t.typnamespace
      left join pg_enum e on e.enumtypid = t.oid
      where t.typrelid = 0 and not exists (
        select 1 from pg_type base where base.typarray = t.oid
      )
      union all
      select jsonb_build_array('rule', c.relname, r.rulename, r.ev_enabled, pg_get_ruledef(r.oid, false))
      from relations c join pg_rewrite r on r.ev_class = c.oid
      union all
      select jsonb_build_array('policy', c.relname, p.polname, p.polcmd, p.polpermissive,
        (select array_agg(case when role_oid = 0 then 'public' else r.rolname end order by role_oid)
          from unnest(p.polroles) role_oid left join pg_roles r on r.oid = role_oid),
        pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid))
      from relations c join pg_policy p on p.polrelid = c.oid
    ) select fact from facts
  `.execute(transaction);
  return result.rows
    .map(({ fact }) => {
      const definitionColumns: Record<string, readonly number[]> = {
        relation: [9, 11],
        column: [4, 10],
        constraint: [7],
        index: [6],
        trigger: [4],
        function: [2, 3],
        type: [4, 6],
        rule: [4],
        policy: [6, 7],
      };
      const normalized = [...fact];
      for (const index of definitionColumns[String(fact[0])] ?? []) {
        if (typeof normalized[index] === 'string')
          normalized[index] = normalizeSchemaQualifiers(normalized[index], schema);
      }
      return JSON.stringify(normalized);
    })
    .sort();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

/** Legacy adoption proves current canonical structure, never past SQL execution. */
export async function attestLegacySchema(
  transaction: Transaction<Database>,
  appliedCount: number,
): Promise<void> {
  const previous = await sql<{ schema: string; search_path: string }>`
    select current_schema() as schema, current_setting('search_path') as search_path
  `.execute(transaction);
  const original = previous.rows[0]!;
  if (!original.schema)
    throw migrationError('MIGRATION_SCHEMA_MISMATCH', 'The application schema does not exist.');
  const expectedSchema = `migration_attestation_${randomUUID().replaceAll('-', '')}`;
  const actual = await catalogFacts(transaction, original.schema);
  await sql`create schema ${sql.id(expectedSchema)}`.execute(transaction);
  await sql`select set_config('search_path', ${`${quoteIdentifier(expectedSchema)}, pg_catalog`}, true)`.execute(
    transaction,
  );
  for (const migration of MIGRATIONS.slice(0, appliedCount)) {
    await sql.raw(migration.statement).execute(transaction);
  }
  const expected = await catalogFacts(transaction, expectedSchema);
  if (actual.length !== expected.length || actual.some((fact, index) => fact !== expected[index]))
    throw migrationError(
      'MIGRATION_SCHEMA_MISMATCH',
      'Legacy schema differs from the canonical migration prefix; no checksums were adopted.',
    );
  await sql`drop schema ${sql.id(expectedSchema)} cascade`.execute(transaction);
  await sql`select set_config('search_path', ${original.search_path}, true)`.execute(transaction);
}
