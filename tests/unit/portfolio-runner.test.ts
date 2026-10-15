import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('refuses an external portfolio database before connecting or creating a fixture', () => {
  const connection = 'postgresql://127.0.0.1:1/do_not_connect';
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/with-postgres.ts', 'portfolio'],
    { env: { ...process.env, TEST_DATABASE_URL: connection }, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('PORTFOLIO_REQUIRES_TEMP_DATABASE');
  expect(result.stderr).not.toContain(connection);
  expect(result.stdout).not.toContain('Running portfolio');
});

it('refuses unsupported demo arguments before loading or creating PostgreSQL', () => {
  const env = { ...process.env };
  delete env.TEST_DATABASE_URL;
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/with-postgres.ts', 'portfolio', '--unknown-private-value'],
    { env, encoding: 'utf8', timeout: 10_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('PORTFOLIO_ARGUMENTS_INVALID');
  expect(result.stderr).toContain('while preparing the runner');
  expect(result.stderr).not.toContain('--unknown-private-value');
  expect(result.stdout).not.toContain('Running portfolio');
});
