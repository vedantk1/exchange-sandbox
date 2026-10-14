import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { Exchange } from '../exchange.js';
import { configuredDatabaseUrl } from '../config/database-url.js';

function quantile(values: number[], fraction: number) {
  return Number(values[Math.max(0, Math.ceil(values.length * fraction) - 1)]!.toFixed(3));
}
const pairs = Number(process.env.BENCHMARK_PAIRS ?? 100);
if (!Number.isInteger(pairs) || pairs < 10 || pairs > 1000)
  throw new Error('BENCHMARK_PAIRS must be 10–1000 matched pairs per worker.');
const databaseUrl = process.env.TEST_DATABASE_URL ?? (await configuredDatabaseUrl());
const owner = new pg.Client({ connectionString: databaseUrl });
await owner.connect();
const results: Record<string, unknown>[] = [];
try {
  for (const concurrency of [1, 4]) {
    const schema = `sandbox_benchmark_${randomUUID().replaceAll('-', '')}`;
    await owner.query(`CREATE SCHEMA "${schema}"`);
    const url = new URL(databaseUrl);
    url.searchParams.set(
      'options',
      `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
    );
    let exchange: Exchange | undefined;
    try {
      exchange = await Exchange.open(url.toString());
      const session = await exchange.bootstrap();
      const participants: { seller: string; buyer: string }[] = [];
      for (let worker = 0; worker < concurrency; worker++) {
        const seller = randomUUID();
        const buyer = randomUUID();
        await exchange.createTrader({
          accountId: seller,
          label: `seller-${worker}`,
          commandId: randomUUID(),
        });
        await exchange.createTrader({
          accountId: buyer,
          label: `buyer-${worker}`,
          commandId: randomUUID(),
        });
        participants.push({ seller, buyer });
      }
      const latencies: number[] = [];
      let lastCommand: Parameters<Exchange['placeLimit']>[0] | undefined;
      let lastResult: Awaited<ReturnType<Exchange['placeLimit']>> | undefined;
      async function work(count: number, measure: boolean) {
        await Promise.all(
          participants.map(async ({ seller, buyer }) => {
            for (let index = 0; index < count; index++) {
              for (const [accountId, side] of [
                [seller, 'SELL'],
                [buyer, 'BUY'],
              ] as const) {
                const input = {
                  accountId,
                  side,
                  commandId: randomUUID(),
                  sessionId: session.sessionId,
                  quantity: '0.0002',
                  price: '50000',
                };
                const started = performance.now();
                const result = await exchange!.placeLimit(input);
                assert.equal(result.status, 'ACCEPTED');
                if (measure) latencies.push(performance.now() - started);
                lastCommand = input;
                lastResult = result;
              }
            }
          }),
        );
      }
      await work(10, false);
      const started = performance.now();
      await work(pairs, true);
      const elapsedMs = performance.now() - started;
      assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
      await exchange.close();
      exchange = await Exchange.open(url.toString(), { migrations: 'verify' });
      assert.deepEqual(await exchange.placeLimit(lastCommand!), lastResult);
      const checks = await owner.query<{ fills: number; resting: number }>(
        `SELECT (SELECT count(*)::int FROM "${schema}".fills) AS fills, (SELECT count(*)::int FROM "${schema}".orders WHERE status IN ('OPEN','PARTIALLY_FILLED')) AS resting`,
      );
      assert.equal(checks.rows[0]!.fills, (pairs + 10) * concurrency);
      assert.equal(checks.rows[0]!.resting, 0);
      latencies.sort((a, b) => a - b);
      results.push({
        concurrency,
        pairsPerWorker: pairs,
        warmupPairsPerWorker: 10,
        measuredCommands: latencies.length,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        commandsPerSecond: Number(((latencies.length * 1000) / elapsedMs).toFixed(2)),
        latencyMs: {
          p50: quantile(latencies, 0.5),
          p95: quantile(latencies, 0.95),
          p99: quantile(latencies, 0.99),
        },
        errors: 0,
        reconciliation: true,
        restartReceiptReplay: true,
        fills: checks.rows[0]!.fills,
      });
    } finally {
      await exchange?.close();
      await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  }
  const version = await owner.query<{ server_version: string }>('SHOW server_version');
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'core-command-benchmark',
    environment: {
      node: process.version,
      postgres: version.rows[0]!.server_version,
      platform: process.platform,
      architecture: process.arch,
      cpuModel: cpus()[0]?.model ?? 'unavailable',
      logicalCpus: cpus().length,
      memoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    },
    workload: {
      quantity: '0.0002 BTC-SIM',
      price: '50000 USD-SIM',
      description:
        'Closed-loop limit sell/buy pairs against one serialized writer and local PostgreSQL; matching and ledger commits included.',
    },
    results,
    limits:
      'Core calls only. HTTP, authentication, TLS, live clients, network latency, sustained load, failure rate at saturation, and production capacity are not measured.',
  };
  await mkdir('.local/operations', { recursive: true, mode: 0o700 });
  await writeFile(
    '.local/operations/benchmark-result.json',
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
} catch {
  console.error(
    'Benchmark failed; inspect the isolated command workload and PostgreSQL connectivity. No capacity claim was recorded.',
  );
  process.exitCode = 1;
} finally {
  await owner.end();
}
