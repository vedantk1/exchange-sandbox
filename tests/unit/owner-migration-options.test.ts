import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  migrationFailureCode,
  ownerMigrationOptions,
} from '../../apps/server/src/deploy/migration-options.js';

afterEach(() => vi.unstubAllEnvs());

describe('owner migration configuration', () => {
  it('requires an explicit baseline before requesting legacy checksum adoption', () => {
    vi.stubEnv('MIGRATION_LEGACY_BASELINE', undefined);
    expect(ownerMigrationOptions()).toEqual({});
    vi.stubEnv('MIGRATION_LEGACY_BASELINE', '');
    expect(ownerMigrationOptions()).toEqual({});
    vi.stubEnv('MIGRATION_LEGACY_BASELINE', '008_order_integrity');
    expect(ownerMigrationOptions()).toEqual({ legacyBaseline: '008_order_integrity' });
  });

  it('keeps migration error codes useful without exposing arbitrary diagnostic content', () => {
    for (const code of ['23514', 'OWNER_WRITER_BUSY', 'MIGRATION_CHECKSUM_MISMATCH']) {
      expect(migrationFailureCode({ code, message: 'Private diagnostics are omitted' })).toBe(code);
    }
    for (const error of [
      undefined,
      null,
      new Error('Private diagnostics are omitted'),
      { code: 'postgresql://private.invalid/exchange' },
      { code: 'MIGRATION_REQUIRED\nprivate diagnostics' },
      { code: 'unsafe lowercase code' },
      { code: 'A'.repeat(65) },
      { code: 23514 },
      { code: '' },
    ]) {
      expect(migrationFailureCode(error)).toBe('OWNER_MIGRATION_FAILED');
    }
  });

  it.each([
    {
      ownerUrl: 'PRIVATE_CONFIG_SENTINEL',
      runtimeFile: '',
      code: 'ERR_INVALID_URL',
    },
    {
      ownerUrl: 'postgresql://unused.invalid/exchange',
      runtimeFile: '.local/PRIVATE_CONFIG_SENTINEL/missing-runtime-url',
      code: 'ENOENT',
    },
  ])(
    'redacts failed owner configuration before any database connection ($code)',
    (configuration) => {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', 'apps/server/src/deploy/initialize.ts'],
        {
          env: {
            ...process.env,
            DATABASE_URL: configuration.ownerUrl,
            DATABASE_URL_FILE: undefined,
            RUNTIME_DATABASE_URL_FILE: configuration.runtimeFile,
          },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      expect(child.status).toBe(1);
      expect(child.stderr).toContain(configuration.code);
      expect(`${child.stdout}${child.stderr}`).not.toContain('PRIVATE_CONFIG_SENTINEL');
    },
  );
});
