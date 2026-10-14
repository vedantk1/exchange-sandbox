import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { createDatabase } from '@sandbox/database';
import { MARKET_CANDLE_INDEX } from '../../../../packages/database/src/large-session-schema.js';
import { marketCandleQuery } from '../market-candles.js';

const baseline = `SELECT date_trunc('minute', created_at) AS timestamp,
  (array_agg(price ORDER BY sequence, fill_index))[1]::text AS open,
  max(price)::text AS high, min(price)::text AS low,
  (array_agg(price ORDER BY sequence DESC, fill_index DESC))[1]::text AS close,
  sum(quantity)::text AS volume FROM fills WHERE session_id=$1
  GROUP BY date_trunc('minute', created_at) ORDER BY timestamp DESC LIMIT 60`;

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Shared Hit Blocks'?: number;
  'Shared Read Blocks'?: number;
  'Temp Read Blocks'?: number;
  'Temp Written Blocks'?: number;
  'Heap Fetches'?: number;
  Plans?: PlanNode[];
}

interface ExplainResult {
  Plan: PlanNode;
  'Planning Time': number;
  'Execution Time': number;
}

function scanSummary(plan: PlanNode) {
  let fillRows = 0;
  let heapFetches = 0;
  const indexes = new Set<string>();
  const scanTypes = new Set<string>();
  function visit(node: PlanNode) {
    if (node['Relation Name'] === 'fills' && node['Node Type'].includes('Scan')) {
      fillRows += node['Actual Rows'] * node['Actual Loops'];
      heapFetches += node['Heap Fetches'] ?? 0;
      scanTypes.add(node['Node Type']);
    }
    if (node['Index Name']) indexes.add(node['Index Name']);
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(plan);
  return {
    fillRowsVisited: fillRows,
    heapFetches,
    indexes: [...indexes].sort(),
    scanTypes: [...scanTypes].sort(),
  };
}

function quantile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!.toFixed(3));
}

/** Disclosed query-only history fixture; separate from the reconciled HTTP workload. */
export async function benchmarkCandles(databaseUrl: string) {
  const schema = `candle_benchmark_${randomUUID().replaceAll('-', '')}`;
  const sessionId = randomUUID();
  const owner = new pg.Client({ connectionString: databaseUrl });
  let connection: pg.Client | undefined;
  let database: ReturnType<typeof createDatabase> | undefined;
  let created = false;
  await owner.connect();
  try {
    await owner.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    const url = new URL(databaseUrl);
    url.searchParams.set(
      'options',
      `${url.searchParams.get('options') ?? ''} -c search_path=${schema} -c timezone=UTC`.trim(),
    );
    connection = new pg.Client({ connectionString: url.toString() });
    await connection.connect();
    database = createDatabase(url.toString());
    // Minimal fill columns retain production numeric/timestamp types and the
    // pre009 sequence indexes. This isolates candle query work from matching,
    // journal construction, authentication and wider production row payloads.
    await connection.query(`CREATE TABLE fills (
      session_id uuid NOT NULL,
      price numeric(38,0) NOT NULL,
      quantity numeric(38,0) NOT NULL,
      sequence bigint NOT NULL,
      fill_index integer NOT NULL,
      created_at timestamptz NOT NULL,
      UNIQUE (session_id, sequence, fill_index)
    ); CREATE INDEX session_fills ON fills (session_id, sequence)`);
    await connection.query(
      `INSERT INTO fills (session_id,price,quantity,sequence,fill_index,created_at)
      SELECT $1::uuid, 5000000 + n % 101, 1, n, 0,
        '2025-01-01T00:00:00Z'::timestamptz + ((n - 1) / 20) * interval '1 minute'
        FROM generate_series(1,100000) n
      UNION ALL
      SELECT $1::uuid, 5000000 + n % 101, 1, 100000 + n, 0,
        '2025-01-01T00:00:00Z'::timestamptz + 5000 * interval '1 minute'
        FROM generate_series(1,5000) n`,
      [sessionId],
    );
    await connection.query('VACUUM (ANALYZE) fills');

    async function measured(statement: string, parameters: readonly unknown[]) {
      const timings: number[] = [];
      let plan: ExplainResult | undefined;
      // Warm both cache and plan paths before recording repeated SQL timings.
      await connection!.query(statement, [...parameters]);
      for (let iteration = 0; iteration < 5; iteration += 1) {
        const started = performance.now();
        await connection!.query(statement, [...parameters]);
        timings.push(performance.now() - started);
      }
      const explanation = await connection!.query<{ 'QUERY PLAN': ExplainResult[] }>(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
        [...parameters],
      );
      plan = explanation.rows[0]!['QUERY PLAN'][0]!;
      return {
        samples: timings.length,
        latencyMs: { p50: quantile(timings, 0.5), p95: quantile(timings, 0.95) },
        explain: {
          planningMs: plan['Planning Time'],
          executionMs: plan['Execution Time'],
          sharedHitBlocks: plan.Plan['Shared Hit Blocks'] ?? 0,
          sharedReadBlocks: plan.Plan['Shared Read Blocks'] ?? 0,
          temporaryReadBlocks: plan.Plan['Temp Read Blocks'] ?? 0,
          temporaryWrittenBlocks: plan.Plan['Temp Written Blocks'] ?? 0,
          ...scanSummary(plan.Plan),
        },
      };
    }

    const expected = (await connection.query(baseline, [sessionId])).rows;
    const before = await measured(baseline, [sessionId]);
    const baselineSize = await connection.query<{ table_bytes: string; index_bytes: string }>(
      "SELECT pg_relation_size('fills')::text AS table_bytes, pg_indexes_size('fills')::text AS index_bytes",
    );
    await connection.query(MARKET_CANDLE_INDEX);
    await connection.query('ANALYZE fills');
    const compiled = marketCandleQuery(sessionId).compile(database);
    const actual = (await connection.query(compiled.sql, [...compiled.parameters])).rows;
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 60);
    assert.equal(actual[0]!.volume, '5000');
    const after = await measured(compiled.sql, compiled.parameters);
    const version = await connection.query<{ server_version: string }>('SHOW server_version');
    const addedSize = await connection.query<{ bytes: string }>(
      "SELECT pg_relation_size('fills_by_minute')::text AS bytes",
    );
    return {
      kind: 'historical-candle-query-comparison',
      postgres: version.rows[0]!.server_version,
      fixture: {
        synthetic: true,
        vacuumedBeforeMeasurement: true,
        totalFills: 105000,
        populatedMinutes: 5001,
        oldFillsPerMinute: 20,
        latestMinuteFills: 5000,
        returnedMinutes: actual.length,
        selectedMinuteFills: 6180,
        description:
          'Isolated minimal fill table with production numeric types and sequence indexes. Synthetic historical timestamps; no accounting or exchange throughput claims.',
      },
      before,
      after,
      storageBytes: {
        table: Number(baselineSize.rows[0]!.table_bytes),
        baselineIndexes: Number(baselineSize.rows[0]!.index_bytes),
        addedMinuteIndex: Number(addedSize.rows[0]!.bytes),
      },
      exactCandlesEqual: true,
      limits:
        'Five warm SQL samples and one EXPLAIN per query on one local database. Fixture vacuumed before measurement; fresh production fills may require heap fetches. Includes a whole latest-minute burst. Production row width, concurrent writers, cold disks and deployment hardware differ.',
    };
  } finally {
    await database?.destroy();
    await connection?.end();
    try {
      if (created) await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
    } finally {
      await owner.end();
    }
  }
}
