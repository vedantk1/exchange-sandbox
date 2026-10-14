import type pg from 'pg';

/** Owner-only tooling. Runtime owns no schema objects and cannot assume another role. */
export async function provisionRuntimeRole(
  owner: pg.Client,
  password: string,
  roleName = 'sandbox_app',
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(roleName)) throw new Error('Invalid runtime role identity.');
  await owner.query('BEGIN');
  try {
    const role = await owner.query<{ oid: number }>('SELECT oid FROM pg_roles WHERE rolname=$1', [
      roleName,
    ]);
    if (role.rowCount !== 0) {
      const owned = await owner.query(
        "SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass AND refobjid=$1 AND deptype='o' LIMIT 1",
        [role.rows[0]!.oid],
      );
      if (owned.rowCount !== 0)
        throw new Error('The runtime role already owns objects; operator review is required.');
      const memberships = await owner.query<{ name: string }>(
        'SELECT quote_ident(r.rolname) AS name FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid WHERE m.member=$1',
        [role.rows[0]!.oid],
      );
      for (const { name } of memberships.rows)
        await owner.query(`REVOKE ${name} FROM ${roleName} CASCADE`);
    }
    const quoted = await owner.query<{ value: string }>('SELECT quote_literal($1) AS value', [
      password,
    ]);
    await owner.query(
      `${role.rowCount === 0 ? `CREATE` : `ALTER`} ROLE ${roleName} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${quoted.rows[0]!.value}`,
    );
    const database = await owner.query<{ name: string }>(
      'SELECT quote_ident(current_database()) AS name',
    );
    await owner.query(`REVOKE ALL ON DATABASE ${database.rows[0]!.name} FROM PUBLIC, ${roleName}`);
    await owner.query(`GRANT CONNECT ON DATABASE ${database.rows[0]!.name} TO ${roleName}`);
    await owner.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    await owner.query(`REVOKE ALL ON SCHEMA public FROM ${roleName}`);
    await owner.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await owner.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${roleName}`);
    await owner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`,
    );
    // A table-wide revoke also removes old column grants. PUBLIC grants must
    // not restore access to accepted terms through implicit membership.
    await owner.query(`REVOKE UPDATE, DELETE, TRUNCATE ON public.orders FROM PUBLIC, ${roleName}`);
    await owner.query(
      `GRANT UPDATE (status, remaining_quantity, reserved_amount, cancel_reason, updated_at)
        ON public.orders TO ${roleName}`,
    );
    const orderPrivileges = await owner.query<{
      broad_update: boolean;
      deletion: boolean;
      truncation: boolean;
      terms_update: boolean;
    }>(
      `SELECT has_table_privilege($1, 'public.orders', 'UPDATE') AS broad_update,
        has_table_privilege($1, 'public.orders', 'DELETE') AS deletion,
        has_table_privilege($1, 'public.orders', 'TRUNCATE') AS truncation,
        EXISTS (
          SELECT 1 FROM pg_attribute
          WHERE attrelid = 'public.orders'::regclass AND attnum > 0 AND NOT attisdropped
            AND attname NOT IN ('status', 'remaining_quantity', 'reserved_amount', 'cancel_reason', 'updated_at')
            AND has_column_privilege($1, attrelid, attnum, 'UPDATE')
        ) AS terms_update`,
      [roleName],
    );
    if (Object.values(orderPrivileges.rows[0]!).some(Boolean))
      throw new Error('The runtime role retains unexpected order update or deletion privileges.');
    // Metadata is SELECT-only for the application. An old PUBLIC grant can
    // otherwise restore TRUNCATE or column updates after a direct role revoke.
    await owner.query(`REVOKE ALL ON public.schema_migrations FROM PUBLIC, ${roleName}`);
    await owner.query(`GRANT SELECT ON public.schema_migrations TO ${roleName}`);
    const metadataPrivileges = await owner.query<{
      table_mutation: boolean;
      column_mutation: boolean;
    }>(
      `SELECT has_table_privilege($1, 'public.schema_migrations',
          'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS table_mutation,
        has_any_column_privilege($1, 'public.schema_migrations',
          'INSERT, UPDATE, REFERENCES') AS column_mutation`,
      [roleName],
    );
    if (Object.values(metadataPrivileges.rows[0]!).some(Boolean))
      throw new Error('The runtime role retains unexpected migration metadata privileges.');
    await owner.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${roleName}`);
    await owner.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`);
    const create = await owner.query(
      "SELECT 1 FROM pg_namespace WHERE has_schema_privilege($1, oid, 'CREATE') LIMIT 1",
      [roleName],
    );
    if (create.rowCount !== 0)
      throw new Error('The runtime role retains an unexpected schema CREATE grant.');
    await owner.query('COMMIT');
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}
