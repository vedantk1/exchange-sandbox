import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { createDatabase, migrate } from '@sandbox/database';
import { configuredDatabaseUrl } from '../config/database-url.js';
import { provisionRuntimeRole } from './runtime-role.js';
import { Exchange } from '../exchange.js';

const ownerUrl = await configuredDatabaseUrl();
const runtimePath = process.env.RUNTIME_DATABASE_URL_FILE;
if (!runtimePath) throw new Error('RUNTIME_DATABASE_URL_FILE is required.');
const runtimeUrl = new URL((await readFile(runtimePath, 'utf8')).trim());
if (runtimeUrl.username !== 'sandbox_app' || !runtimeUrl.password)
  throw new Error('A distinct restricted runtime role is required.');
const owner = new pg.Client({ connectionString: ownerUrl });
const database = createDatabase(ownerUrl);
try {
  await owner.connect();
  // Migration tooling obeys the same singleton writer ownership as the API.
  const locked = await owner.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_lock($1) AS acquired',
    [7_314_921],
  );
  if (!locked.rows[0]?.acquired) throw new Error('Stop the API before migrating.');
  await migrate(database);
  await provisionRuntimeRole(owner, decodeURIComponent(runtimeUrl.password));
  await owner.query('SELECT pg_advisory_unlock($1)', [7_314_921]);
  const runtime = await Exchange.open(runtimeUrl.toString(), {
    migrations: 'verify',
    allowFaultedStartup: true,
  });
  await runtime.close();
  console.log('Migrations applied; restricted runtime role provisioned without schema ownership.');
} catch {
  console.error(
    'Owner initialization failed. Stop the API and inspect database connectivity or migration state. Credentials were not printed.',
  );
  process.exitCode = 1;
} finally {
  await database.destroy();
  await owner.end();
}
