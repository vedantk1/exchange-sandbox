import { mkdir, writeFile } from 'node:fs/promises';
import { configuredDatabaseUrl } from '../config/database-url.js';
import { benchmarkCandles } from './candle-benchmark.js';

try {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? (await configuredDatabaseUrl());
  const report = {
    generatedAt: new Date().toISOString(),
    ...(await benchmarkCandles(databaseUrl)),
  };
  await mkdir('.local/operations', { recursive: true, mode: 0o700 });
  await writeFile('.local/operations/candle-result.json', `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(
    'Candle benchmark failed; inspect the isolated query fixture and PostgreSQL connectivity. No comparison result was recorded.',
  );
  process.exitCode = 1;
}
