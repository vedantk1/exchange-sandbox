import { configuredDatabaseUrl } from '../config/database-url.js';
import { migrateOwner } from './owner-initialization.js';
import { migrationFailureCode, ownerMigrationOptions } from './migration-options.js';

try {
  await migrateOwner(await configuredDatabaseUrl(), ownerMigrationOptions());
  console.log('Owner migrations and checksums verified. Existing financial records were retained.');
} catch (error) {
  console.error(
    `Owner migration failed (${migrationFailureCode(error)}). Stop the API and inspect the migration adoption instructions; no credentials were printed.`,
  );
  process.exitCode = 1;
}
