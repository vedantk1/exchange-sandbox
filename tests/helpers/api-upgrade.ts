import { randomUUID } from 'node:crypto';
import pg from 'pg';

/** Raw isolated schema for testing installation from an earlier migration. */
export async function createUpgradeDatabase() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `exchange_upgrade_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new pg.Pool({ connectionString });
  await owner.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set(
    'options',
    `${databaseUrl.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
  );
  const url = databaseUrl.toString();
  const sql = new pg.Pool({ connectionString: url });
  return {
    url,
    sql,
    async dispose() {
      await sql.end();
      try {
        await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await owner.end();
      }
    },
  };
}
