import assert from 'node:assert/strict';
import { Exchange } from '../../apps/server/src/exchange.js';
import { isolatedDatabase } from '../../apps/server/src/operations/database.js';
import { startBenchmarkServer } from '../../apps/server/src/operations/benchmark-process.js';

const ownerUrl = process.env.TEST_DATABASE_URL;
if (!ownerUrl) throw new Error('TEST_DATABASE_URL is required for the isolated runtime smoke.');
const database = await isolatedDatabase(ownerUrl);
let exchange: Exchange | undefined;
let server: Awaited<ReturnType<typeof startBenchmarkServer>> | undefined;
try {
  exchange = await Exchange.open(database.url);
  await exchange.bootstrap();
  await exchange.close();
  exchange = undefined;
  server = await startBenchmarkServer(database.url);
  const response = await fetch(`${server.origin}/health/live`, {
    signal: AbortSignal.timeout(2_000),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { alive: true });
  await server.startMeasurement();
  const memory = await server.stopMeasurement();
  assert.ok(memory.baselineRss > 0 && memory.peakRss >= memory.baselineRss);
} finally {
  await server?.close();
  await exchange?.close();
  await database.dispose();
}
