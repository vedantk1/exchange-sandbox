import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { HistoryPageView, PreparedHistoryExportView, WorkspaceView } from '@sandbox/contracts';
import { formatQuantity, formatQuote } from '@sandbox/domain';
import { AdminService } from '../admin/service.js';
import { AuthService } from '../auth/service.js';
import { configuredDatabaseUrl } from '../config/database-url.js';
import { Exchange } from '../exchange.js';
import type { CommandResult, LimitCommand } from '../types.js';
import { benchmarkCandles } from './candle-benchmark.js';
import { startBenchmarkServer } from './benchmark-process.js';

interface Measurement {
  operation: string;
  latencyMs: number;
  status: number | null;
  code: string | null;
}
interface Commit {
  sequence: string;
  startedAt: number;
  acknowledgedAt: number;
}
interface Frame {
  event: string;
  cursor: string;
  receivedAt: number;
}

function integerEnvironment(name: string, fallback: number, minimum: number, maximum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum)
    throw new Error(`${name} must be ${minimum}–${maximum}.`);
  return value;
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length
    ? Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3))
    : null;
}

class HttpClient {
  private cookies = new Map<string, string>();
  private csrf = '';

  constructor(
    readonly origin: string,
    private readonly measurements: Measurement[],
  ) {}

  get headers() {
    return {
      origin: this.origin,
      cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '),
      ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
    };
  }

  async json<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    operation?: string,
  ): Promise<T> {
    const started = performance.now();
    let status: number | null = null;
    let code: string | null = null;
    try {
      const response = await fetch(`${this.origin}${path}`, {
        method,
        headers: {
          ...this.headers,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(40_000),
      });
      status = response.status;
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]!;
        const boundary = pair.indexOf('=');
        this.cookies.set(pair.slice(0, boundary), pair.slice(boundary + 1));
      }
      const result: unknown = await response.json();
      if (result && typeof result === 'object') {
        if ('csrfToken' in result && typeof result.csrfToken === 'string')
          this.csrf = result.csrfToken;
        if ('code' in result && typeof result.code === 'string') code = result.code;
      }
      assert.equal(status, 200, `HTTP ${operation ?? 'setup'} returned ${status}`);
      return result as T;
    } catch (error) {
      code ??=
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'CLIENT_TIMEOUT'
          : 'REQUEST_FAILED';
      throw error;
    } finally {
      if (operation)
        this.measurements.push({ operation, latencyMs: performance.now() - started, status, code });
    }
  }

  async download(file: PreparedHistoryExportView['files'][number], operation: string) {
    const started = performance.now();
    let status: number | null = null;
    let code: string | null = null;
    try {
      const response = await fetch(`${this.origin}${file.downloadUrl}`, {
        headers: this.headers,
        signal: AbortSignal.timeout(40_000),
      });
      status = response.status;
      assert.equal(status, 200, `HTTP ${operation} returned ${status}`);
      assert.ok(response.body, 'Download has no response body');
      const hash = createHash('sha256');
      let bytes = 0;
      let records = 0;
      let quoted = false;
      const balances: Buffer[] = [];
      if (file.name === 'balances.csv')
        assert.ok(
          file.bytes <= 16_384,
          'Benchmark balances exceed the disclosed small-account fixture',
        );
      // Count only record delimiters outside quoted fields; never retain the complete download.
      const reader = response.body.getReader();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (file.name === 'balances.csv') balances.push(Buffer.from(chunk));
        hash.update(chunk);
        bytes += chunk.byteLength;
        for (const value of chunk) {
          if (value === 34) quoted = !quoted;
          if (value === 10 && !quoted) records++;
        }
      }
      assert.equal(quoted, false, 'CSV ends inside a quoted field');
      assert.equal(bytes, file.bytes, 'Downloaded byte count differs from prepared metadata');
      assert.equal(
        hash.digest('hex'),
        file.sha256,
        'Downloaded digest differs from prepared metadata',
      );
      assert.equal(records - 1, file.rows, 'Downloaded row count differs from prepared metadata');
      return {
        name: file.name,
        rows: file.rows,
        bytes,
        ...(file.name === 'balances.csv'
          ? { balances: balanceRows(Buffer.concat(balances).toString('utf8')) }
          : {}),
      };
    } catch (error) {
      code =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? 'CLIENT_TIMEOUT'
          : 'DOWNLOAD_FAILED';
      throw error;
    } finally {
      this.measurements.push({ operation, latencyMs: performance.now() - started, status, code });
    }
  }
}

/** This fixture's balances contain only UUIDs, fixed asset names, and exact decimals. */
function balanceRows(csv: string) {
  const rows = csv
    .trimEnd()
    .split('\r\n')
    .map((line) => line.slice(1, -1).split('","'));
  assert.deepEqual(rows.shift(), ['accountId', 'asset', 'available', 'reserved', 'total']);
  return rows.map(([accountId, asset, available, reserved, total]) => ({
    accountId,
    asset,
    available,
    reserved,
    total,
  }));
}

async function openLive(client: HttpClient, sessionId: string, cursor: string) {
  const controller = new AbortController();
  const response = await fetch(
    `${client.origin}/api/events?sessionId=${sessionId}&cursor=${cursor}`,
    { headers: client.headers, signal: controller.signal },
  );
  assert.equal(response.status, 200, 'Live connection was rejected');
  assert.ok(response.body, 'Live connection has no body');
  const frames: Frame[] = [];
  let failure: unknown;
  let buffered = '';
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const consuming = (async () => {
    try {
      while (!controller.signal.aborted) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffered += decoder.decode(chunk.value, { stream: true });
        while (buffered.includes('\n\n')) {
          const boundary = buffered.indexOf('\n\n');
          const frame = buffered.slice(0, boundary);
          buffered = buffered.slice(boundary + 2);
          const event = frame.match(/^event: (.+)$/m)?.[1] ?? '';
          const id = frame.match(/^id: (.+)$/m)?.[1] ?? '';
          frames.push({ event, cursor: id, receivedAt: performance.now() });
          if (['auth-lost', 'unavailable', 'reset'].includes(event))
            throw new Error('Live benchmark connection lost its coherent stream');
        }
      }
      if (!controller.signal.aborted) throw new Error('Live benchmark stream ended early');
    } catch (error) {
      if (!controller.signal.aborted) failure = error;
    }
  })();
  return {
    frames,
    async catchUp(target: string) {
      const deadline = performance.now() + 10_000;
      while (!frames.some((frame) => frame.cursor && BigInt(frame.cursor) >= BigInt(target))) {
        if (failure) throw failure;
        if (performance.now() >= deadline) throw new Error('Live benchmark catch-up timed out');
        await delay(20);
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await consuming;
      if (failure) throw failure;
    },
  };
}

/** The writer is serialized; immutable records at this outbox boundary independently verify export counts. */
async function exportCounts(
  sql: pg.Pool,
  sessionId: string,
  accountId: string | null,
  cursor: string,
) {
  const sequence = await sql.query<{ sequence: string }>(
    'SELECT max(sequence)::text AS sequence FROM outbox WHERE session_id=$1 AND id <= $2',
    [sessionId, cursor],
  );
  const boundary = sequence.rows[0]!.sequence;
  // Production identity is (actor, command); this benchmark deliberately uses a
  // distinct UUID for every command. Assert that fixture assumption before joins.
  const duplicate = await sql.query<{ duplicates: number }>(
    'SELECT (count(*) - count(DISTINCT command_id))::int AS duplicates FROM receipts WHERE session_id=$1 AND sequence <= $2',
    [sessionId, boundary],
  );
  assert.equal(duplicate.rows[0]!.duplicates, 0, 'Benchmark command IDs are not globally unique');
  const result = await sql.query<Record<string, number>>(
    `SELECT
      (SELECT count(*)::int FROM orders WHERE session_id=$1 AND acceptance_sequence <= $3 AND ($2::uuid IS NULL OR account_id=$2)) AS orders,
      (SELECT count(*)::int FROM fills f JOIN orders b ON b.id=f.buy_order_id JOIN orders s ON s.id=f.sell_order_id WHERE f.session_id=$1 AND f.sequence <= $3 AND ($2::uuid IS NULL OR b.account_id=$2 OR s.account_id=$2)) AS fills,
      (SELECT count(*)::int FROM journal_entries e JOIN journal_transactions j ON j.id=e.journal_transaction_id JOIN receipts r ON r.command_id=j.command_id AND r.session_id=j.session_id WHERE e.session_id=$1 AND r.sequence <= $3 AND ($2::uuid IS NULL OR e.account_id=$2)) AS activity,
      (SELECT count(*)::int FROM receipts WHERE session_id=$1 AND sequence <= $3 AND ($2::uuid IS NULL OR (actor_id=$2 AND result->>'status' IN ('ACCEPTED','REJECTED')))) AS commands,
      (SELECT count(DISTINCT account_id)::int * 2 FROM balances WHERE session_id=$1 AND ($2::uuid IS NULL OR account_id=$2)) AS balances,
      (SELECT count(*)::int FROM admin_audit a LEFT JOIN receipts r ON r.command_id=a.command_id WHERE a.session_id=$1 AND (r.sequence <= $3 OR a.action='ADMIN_BOOTSTRAPPED')) AS audit`,
    [sessionId, accountId, boundary],
  );
  return { counts: result.rows[0]!, boundary };
}

async function ledgerBalances(
  sql: pg.Pool,
  sessionId: string,
  accountId: string | null,
  boundary: string,
) {
  const entries = await sql.query<{
    account_id: string;
    asset: string;
    bucket: string;
    amount: string;
  }>(
    `SELECT e.account_id, e.asset, e.bucket, sum(e.amount)::text AS amount
      FROM journal_entries e JOIN journal_transactions j ON j.id=e.journal_transaction_id
      JOIN receipts r ON r.command_id=j.command_id AND r.session_id=j.session_id
      WHERE e.session_id=$1 AND r.sequence <= $3 AND ($2::uuid IS NULL OR e.account_id=$2)
      GROUP BY e.account_id, e.asset, e.bucket`,
    [sessionId, accountId, boundary],
  );
  const amounts = new Map(
    entries.rows.map((row) => [`${row.account_id}:${row.asset}:${row.bucket}`, BigInt(row.amount)]),
  );
  return [...new Set(entries.rows.map((row) => row.account_id))].sort().flatMap((id) =>
    ['BTC-SIM', 'USD-SIM'].map((asset) => {
      const available = amounts.get(`${id}:${asset}:AVAILABLE`) ?? 0n;
      const reserved = amounts.get(`${id}:${asset}:RESERVED`) ?? 0n;
      const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
      return {
        accountId: id,
        asset,
        available: format(available),
        reserved: format(reserved),
        total: format(available + reserved),
      };
    }),
  );
}

const seedPairs = integerEnvironment('BENCHMARK_SESSION_PAIRS', 10_001, 10, 25_000);
const measuredPairs = integerEnvironment('BENCHMARK_HTTP_PAIRS', 100, 10, 150);
const databaseUrl = process.env.TEST_DATABASE_URL ?? (await configuredDatabaseUrl());
const owner = new pg.Pool({ connectionString: databaseUrl });
const schema = `sandbox_session_benchmark_${randomUUID().replaceAll('-', '')}`;
let exchange: Exchange | undefined;
let server: Awaited<ReturnType<typeof startBenchmarkServer>> | undefined;
let sql: pg.Pool | undefined;
const streams: Awaited<ReturnType<typeof openLive>>[] = [];
const measurements: Measurement[] = [];
let sampler: NodeJS.Timeout | undefined;
let created = false;
let stage = 'isolated database setup';

try {
  await owner.query(`CREATE SCHEMA "${schema}"`);
  created = true;
  const url = new URL(databaseUrl);
  url.searchParams.set(
    'options',
    `${url.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
  );
  sql = new pg.Pool({ connectionString: url.toString() });
  exchange = await Exchange.open(url.toString());
  stage = 'authentication setup';
  const auth = new AuthService(exchange);
  const password = randomBytes(24).toString('base64url');
  const setup = await auth.bootstrapAdmin({ handle: 'benchmark_operator', password });
  const adminLogin = await auth.login({ handle: 'benchmark_operator', password });
  const participants = [];
  for (const handle of ['benchmark_seller', 'benchmark_buyer']) {
    const invitation = await auth.issueInvitation(adminLogin.token, {
      commandId: randomUUID(),
      sessionId: setup.sessionId,
      reason: 'Create isolated benchmark participant',
    });
    assert.equal(invitation.status, 'ACCEPTED');
    assert.ok(invitation.token);
    participants.push(await auth.redeemInvitation({ token: invitation.token, handle, password }));
  }
  const [seller, buyer] = participants;
  assert.ok(seller && buyer);
  const admin = new AdminService(exchange);
  const grant = await admin.grant(adminLogin.token, {
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    reason: 'Fund disclosed isolated benchmark inventory',
    accountId: seller.accountId,
    asset: 'BTC-SIM',
    amount: String(Math.ceil((seedPairs + measuredPairs) / 10_000)),
  });
  assert.equal(grant.status, 'ACCEPTED');
  const resumed = await admin.resume(adminLogin.token, {
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    reason: 'Start isolated benchmark trading',
  });
  assert.equal(resumed.status, 'ACCEPTED');
  let lastInput: LimitCommand | undefined;
  let lastResult: CommandResult | undefined;
  const input = (accountId: string, side: 'SELL' | 'BUY'): LimitCommand => ({
    accountId,
    side,
    commandId: randomUUID(),
    sessionId: setup.sessionId,
    quantity: '0.0001',
    price: '10000',
  });
  stage = 'real command seeding';
  const seedStarted = performance.now();
  for (let pair = 0; pair < seedPairs; pair++) {
    for (const [accountId, side] of [
      [seller.accountId, 'SELL'],
      [buyer.accountId, 'BUY'],
    ] as const) {
      lastInput = input(accountId, side);
      lastResult = await exchange.placeLimit(lastInput);
      assert.equal(lastResult.status, 'ACCEPTED');
    }
  }
  const seedMs = performance.now() - seedStarted;
  assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
  stage = 'loopback API startup';
  // Close the seed writer before the actual API process takes the installation guard.
  await exchange.close();
  exchange = undefined;
  server = await startBenchmarkServer(url.toString());
  const address = server.origin;
  const trader = new HttpClient(address, measurements);
  const counterparty = new HttpClient(address, measurements);
  const operator = new HttpClient(address, measurements);
  await Promise.all([
    trader.json('POST', '/api/auth/login', { handle: seller.handle, password }),
    counterparty.json('POST', '/api/auth/login', { handle: buyer.handle, password }),
    operator.json('POST', '/api/auth/login', { handle: 'benchmark_operator', password }),
  ]);
  const initial = await trader.json<WorkspaceView>('GET', '/api/workspace');
  streams.push(await openLive(trader, setup.sessionId, initial.cursor));
  streams.push(await openLive(counterparty, setup.sessionId, initial.cursor));
  await Promise.all(streams.map((stream) => stream.catchUp(initial.cursor)));

  stage = 'mixed HTTP workload';
  console.log(
    'Seed and authentication are complete; starting the measured HTTP phase in a separate API process.',
  );
  await server.startMeasurement();
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeap = baseline.heapUsed;
  sampler = setInterval(() => {
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }, 50);
  const commits: Commit[] = [];
  const exports: { scope: string; files: { name: string; rows: number; bytes: number }[] }[] = [];
  const started = performance.now();
  const tasks = await Promise.allSettled([
    (async () => {
      for (let pair = 0; pair < measuredPairs; pair++) {
        const orderParticipants: readonly [HttpClient, string, 'SELL' | 'BUY'][] = [
          [trader, seller.accountId, 'SELL'],
          [counterparty, buyer.accountId, 'BUY'],
        ];
        for (const [client, accountId, side] of orderParticipants) {
          const command = input(accountId, side);
          const { accountId: _account, ...body } = command;
          const startedAt = performance.now();
          const result: CommandResult = await client.json<CommandResult>(
            'POST',
            '/api/orders',
            body,
            'order',
          );
          assert.equal(result.status, 'ACCEPTED');
          commits.push({ sequence: result.sequence, startedAt, acknowledgedAt: performance.now() });
          lastInput = command;
          lastResult = result;
        }
      }
    })(),
    (async () => {
      let cursor: string | null = null;
      for (let iteration = 0; iteration < 30; iteration++) {
        const workspace = await trader.json<WorkspaceView>(
          'GET',
          '/api/workspace',
          undefined,
          'workspace-chart',
        );
        assert.ok(workspace.market.candles.length > 0);
        const page: HistoryPageView = await trader.json<HistoryPageView>(
          'GET',
          `/api/history/${setup.sessionId}/page?kind=orders&limit=100${cursor ? `&cursor=${cursor}` : ''}`,
          undefined,
          'history-page',
        );
        assert.ok(page.items.length > 0);
        cursor = page.nextCursor;
      }
    })(),
    ...(
      [
        [operator, null, 'ADMIN_SESSION'],
        [trader, seller.accountId, 'TRADER_ACCOUNT'],
      ] as const
    ).map(async ([client, accountId, scope]) => {
      const prepared = await client.json<PreparedHistoryExportView>(
        'POST',
        `/api/history/${setup.sessionId}/exports`,
        {},
        'export-prepare',
      );
      assert.equal(prepared.accountId, accountId);
      const { counts: expected, boundary } = await exportCounts(
        sql!,
        setup.sessionId,
        accountId,
        prepared.cursor,
      );
      const expectedBalances = await ledgerBalances(sql!, setup.sessionId, accountId, boundary);
      const files = [];
      for (const file of prepared.files) {
        const kind = file.name.replace(/\.csv$/, '');
        assert.equal(
          file.rows,
          kind === 'manifest' ? 1 : expected[kind],
          `Independent ${scope} ${kind} export count differs`,
        );
        const downloaded = await client.download(file, 'export-download');
        if (downloaded.balances) {
          assert.deepEqual(
            [...downloaded.balances].sort((left, right) =>
              `${left.accountId}:${left.asset}`.localeCompare(`${right.accountId}:${right.asset}`),
            ),
            expectedBalances,
            'Exported balances differ from the immutable journal prefix',
          );
        }
        files.push({ name: downloaded.name, rows: downloaded.rows, bytes: downloaded.bytes });
      }
      exports.push({ scope, files });
    }),
  ]);
  const failures = tasks.filter((task) => task.status === 'rejected');
  if (failures.length) throw failures[0]!.reason;
  const elapsedMs = performance.now() - started;
  stage = 'live catch-up';
  const finalCursor = await sql.query<{ id: string }>(
    'SELECT max(id)::text AS id FROM outbox WHERE session_id=$1',
    [setup.sessionId],
  );
  await Promise.all(streams.map((stream) => stream.catchUp(finalCursor.rows[0]!.id)));
  clearInterval(sampler);
  sampler = undefined;
  const serverMemory = await server.stopMeasurement();
  console.log(
    'Measured HTTP phase finished; verifying live delivery, exact ledger evidence, and process restart.',
  );
  const outbox = await sql.query<{ id: string; sequence: string }>(
    'SELECT id::text, sequence::text FROM outbox WHERE session_id=$1 AND sequence >= $2',
    [setup.sessionId, commits[0]!.sequence],
  );
  const bySequence = new Map(outbox.rows.map((row) => [row.sequence, row.id]));
  const live = streams.map((stream) => {
    const latencies = commits.map((commit) => {
      const id = bySequence.get(commit.sequence)!;
      const frame = stream.frames.find((item) => item.cursor && BigInt(item.cursor) >= BigInt(id));
      assert.ok(frame, 'Committed order did not reach the live client');
      return {
        deliveryMs: frame.receivedAt - commit.startedAt,
        acknowledgementLagMs: Math.max(0, frame.receivedAt - commit.acknowledgedAt),
      };
    });
    return {
      frames: stream.frames.length,
      invalidations: stream.frames.filter((frame) => frame.event === 'invalidate').length,
      measuredCommitsObserved: latencies.length,
      requestToNotificationMs: {
        p50: quantile(
          latencies.map((item) => item.deliveryMs),
          0.5,
        ),
        p95: quantile(
          latencies.map((item) => item.deliveryMs),
          0.95,
        ),
      },
      acknowledgementToNotificationMs: {
        p50: quantile(
          latencies.map((item) => item.acknowledgementLagMs),
          0.5,
        ),
        p95: quantile(
          latencies.map((item) => item.acknowledgementLagMs),
          0.95,
        ),
      },
      finalCursorCaughtUp: true,
    };
  });
  await Promise.all(streams.splice(0).map((stream) => stream.close()));
  const totals = await sql.query<{ orders: number; fills: number; activity: number }>(
    'SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM fills) AS fills, (SELECT count(*)::int FROM journal_entries) AS activity',
  );
  assert.equal(totals.rows[0]!.orders, (seedPairs + measuredPairs) * 2);
  assert.equal(totals.rows[0]!.fills, seedPairs + measuredPairs);
  stage = 'restart verification';
  const oldPort = server.port;
  await server.close();
  server = undefined;
  server = await startBenchmarkServer(url.toString(), oldPort);
  const { accountId: _replayedAccount, ...replayedBody } = lastInput!;
  assert.deepEqual(await counterparty.json('POST', '/api/orders', replayedBody), lastResult);
  await server.close();
  server = undefined;
  exchange = await Exchange.open(url.toString(), { migrations: 'verify' });
  assert.deepEqual(await exchange.reconcile(), { ok: true, issues: [] });
  const version = await owner.query<{ server_version: string }>('SHOW server_version');
  stage = 'historical candle comparison';
  const candleQuery = await benchmarkCandles(databaseUrl);
  const report = {
    generatedAt: new Date().toISOString(),
    kind: 'large-session-http-benchmark',
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
      seedPairs,
      seedOrders: seedPairs * 2,
      seedElapsedMs: Number(seedMs.toFixed(2)),
      quantity: '0.0001 BTC-SIM',
      price: '10000 USD-SIM',
      measuredPairs,
      historyPages: 30,
      workspaceChartRequests: 30,
      liveClients: 2,
      exportScopes: ['ADMIN_SESSION', 'TRADER_ACCOUNT'],
      note: 'Unmeasured seed uses real core commands and a paused administrator inventory grant, then closes its writer. A separate Node.js API process in development mode owns the guard during the measured phase: real loopback HTTP, cookie authentication, CSRF, default admission/rate limits, default 1-second SSE polling, and streaming downloads. All financial timestamps use real PostgreSQL time.',
    },
    elapsedMs: Number(elapsedMs.toFixed(2)),
    requests: measurements.length,
    requestsPerSecond: Number(((measurements.length * 1000) / elapsedMs).toFixed(2)),
    operations: [...new Set(measurements.map((item) => item.operation))].map((operation) => {
      const items = measurements.filter((item) => item.operation === operation);
      const latency = items.map((item) => item.latencyMs);
      return {
        operation,
        requests: items.length,
        latencyMs: {
          p50: quantile(latency, 0.5),
          p95: quantile(latency, 0.95),
          p99: quantile(latency, 0.99),
        },
        errors: items.filter((item) => item.code || item.status !== 200).length,
        timeouts: items.filter(
          (item) => item.code === 'CLIENT_TIMEOUT' || item.code === 'DATABASE_TIMEOUT',
        ).length,
      };
    }),
    memory: {
      scope:
        'API server and workload driver are separate Node.js processes. PostgreSQL, OS cache, and browser memory are excluded. Warm authentication memory remains part of the API baseline.',
      server: {
        samplingIntervalMs: serverMemory.samplingIntervalMs,
        baselineRssMiB: Number((serverMemory.baselineRss / 1024 ** 2).toFixed(2)),
        peakRssMiB: Number((serverMemory.peakRss / 1024 ** 2).toFixed(2)),
        baselineHeapUsedMiB: Number((serverMemory.baselineHeapUsed / 1024 ** 2).toFixed(2)),
        peakHeapUsedMiB: Number((serverMemory.peakHeapUsed / 1024 ** 2).toFixed(2)),
      },
      driver: {
        samplingIntervalMs: 50,
        baselineRssMiB: Number((baseline.rss / 1024 ** 2).toFixed(2)),
        peakRssMiB: Number((peakRss / 1024 ** 2).toFixed(2)),
        baselineHeapUsedMiB: Number((baseline.heapUsed / 1024 ** 2).toFixed(2)),
        peakHeapUsedMiB: Number((peakHeap / 1024 ** 2).toFixed(2)),
      },
    },
    live,
    exports,
    records: totals.rows[0],
    exportEvidence: {
      independentSnapshotRowCounts: true,
      independentJournalPrefixBalances: true,
      streamedByteCountsAndHashes: true,
    },
    reconciliation: true,
    restartReceiptReplay: true,
    candleQuery,
    limits:
      'A bounded closed-loop local workload, not a saturation or deployment-capacity claim. TLS, remote-network latency, password-hashing concurrency, PostgreSQL memory, sustained load, and browser rendering are not measured. Export latency includes preparation and separate immutable-file transfers. Candle EXPLAIN evidence uses a separately disclosed synthetic historical fixture, not altered trading evidence.',
  };
  await mkdir('.local/operations', { recursive: true, mode: 0o700 });
  await writeFile(
    '.local/operations/large-session-benchmark-result.json',
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(
    `Large-session benchmark failed during ${stage}; no successful performance evidence was recorded.`,
    error instanceof Error ? error.name : 'UnknownError',
    error instanceof Error && !error.message.includes('postgresql:')
      ? error.message
      : 'Inspect PostgreSQL connectivity.',
  );
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await Promise.allSettled(streams.splice(0).map((stream) => stream.close()));
  await server?.close();
  await exchange?.close();
  await sql?.end();
  try {
    if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
  } finally {
    await owner.end();
  }
}
