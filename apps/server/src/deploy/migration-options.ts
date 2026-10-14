import type { MigrationOptions } from '@sandbox/database';

/** Owner tooling only. Runtime startup never adopts legacy checksums implicitly. */
export function ownerMigrationOptions(): MigrationOptions {
  const legacyBaseline = process.env.MIGRATION_LEGACY_BASELINE;
  return legacyBaseline ? { legacyBaseline } : {};
}

export function migrationFailureCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code)
    ? code
    : 'OWNER_MIGRATION_FAILED';
}
