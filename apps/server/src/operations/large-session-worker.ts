import { createServer } from 'node:net';
import { buildApi } from '../api.js';
import { AuthService } from '../auth/service.js';
import { Exchange } from '../exchange.js';
import { createShutdown } from '../shutdown.js';
import type { ServerMemory } from './benchmark-process.js';

const databaseUrl = process.env.BENCHMARK_DATABASE_URL;
if (!process.send || !databaseUrl || process.env.NODE_ENV !== 'development') {
  console.error(
    'The isolated benchmark worker requires its parent IPC channel and development configuration.',
  );
  process.exit(1);
}

let exchange: Exchange | undefined;
let app: Awaited<ReturnType<typeof buildApi>> | undefined;
let sampler: NodeJS.Timeout | undefined;
let memory: ServerMemory | undefined;

const close = createShutdown({
  stopSimulator: async () => {
    clearInterval(sampler);
  },
  closeHttp: async () => app?.close(),
  closeExchange: async () => exchange?.close(),
  terminate: () => process.exit(1),
});

async function finish(success: boolean) {
  try {
    await close();
    if (process.connected) {
      process.send!({ type: 'stopped' }, () => {
        process.disconnect();
        process.exit(success ? 0 : 1);
      });
    } else process.exit(success ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

async function availablePort() {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const address = listener.address();
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('PORT_UNAVAILABLE');
  return address.port;
}

process.once('disconnect', () => {
  void finish(false);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void finish(false);
  });
}
process.on('message', (message: unknown) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return;
  if (message.type === 'measure-start') {
    clearInterval(sampler);
    const baseline = process.memoryUsage();
    memory = {
      samplingIntervalMs: 50,
      baselineRss: baseline.rss,
      peakRss: baseline.rss,
      baselineHeapUsed: baseline.heapUsed,
      peakHeapUsed: baseline.heapUsed,
    };
    sampler = setInterval(() => {
      if (!memory) return;
      const usage = process.memoryUsage();
      memory.peakRss = Math.max(memory.peakRss, usage.rss);
      memory.peakHeapUsed = Math.max(memory.peakHeapUsed, usage.heapUsed);
    }, 50);
    process.send!({ type: 'measurement-started' });
  } else if (message.type === 'measure-stop') {
    clearInterval(sampler);
    const usage = process.memoryUsage();
    if (memory) {
      memory.peakRss = Math.max(memory.peakRss, usage.rss);
      memory.peakHeapUsed = Math.max(memory.peakHeapUsed, usage.heapUsed);
    }
    process.send!({ type: 'measurement-stopped', memory });
  } else if (message.type === 'close') void finish(true);
});

try {
  const port = process.env.BENCHMARK_API_PORT
    ? Number(process.env.BENCHMARK_API_PORT)
    : await availablePort();
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT_INVALID');
  exchange = await Exchange.open(databaseUrl, { migrations: 'verify' });
  app = await buildApi({
    exchange,
    auth: new AuthService(exchange),
    origin: `http://127.0.0.1:${port}`,
    secureCookies: false,
    logger: false,
  });
  await app.listen({ host: '127.0.0.1', port });
  process.send!({ type: 'ready', port });
} catch (error) {
  const code = (error as { code?: unknown })?.code;
  process.send!({
    type: 'failed',
    code: typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'STARTUP_FAILED',
  });
  await finish(false);
}
