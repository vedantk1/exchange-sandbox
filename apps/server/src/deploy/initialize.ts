import { readFile } from 'node:fs/promises';
import { configuredDatabaseUrl } from '../config/database-url.js';
import { initializeOwner } from './owner-initialization.js';
import { migrationFailureCode, ownerMigrationOptions } from './migration-options.js';

try {
  const ownerUrl = await configuredDatabaseUrl();
  const runtimePath = process.env.RUNTIME_DATABASE_URL_FILE;
  if (!runtimePath) throw new Error('RUNTIME_DATABASE_URL_FILE is required.');
  const runtimeUrl = new URL((await readFile(runtimePath, 'utf8')).trim());
  if (runtimeUrl.username !== 'sandbox_app' || !runtimeUrl.password)
    throw new Error('A distinct restricted runtime role is required.');
  await initializeOwner(ownerUrl, runtimeUrl, ownerMigrationOptions());
  console.log('Migrations applied; restricted runtime role provisioned without schema ownership.');
} catch (error) {
  console.error(
    `Owner initialization failed (${migrationFailureCode(error)}). Stop the API and inspect database connectivity or migration adoption instructions. Credentials were not printed.`,
  );
  process.exitCode = 1;
}
