import { buildApi } from './api.js';
import { AuthService } from './auth/index.js';
import { Exchange, WriterUnavailableError } from './exchange.js';
import { DemoMarket } from './demo-market/service.js';
import { configuredDatabaseUrl } from './config/database-url.js';

let exchange: Exchange | undefined;
let app: Awaited<ReturnType<typeof buildApi>> | undefined;
let shutdown: Promise<void> | undefined;
let simulator: DemoMarket | undefined;

function safeCode(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'STARTUP_FAILED';
}

async function close(): Promise<void> {
  shutdown ??= (async () => {
    try {
      await simulator?.close();
    } finally {
      try {
        await app?.close();
      } finally {
        await exchange?.close();
      }
    }
  })();
  return shutdown;
}

try {
  const databaseUrl = await configuredDatabaseUrl();
  const rawPort = process.env.PORT ?? '3000';
  if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65_535)
    throw new Error('PORT must be an integer between 1 and 65535.');
  const port = Number(rawPort);
  const host = process.env.HOST ?? '127.0.0.1';
  const rawProxyHops = process.env.TRUST_PROXY_HOPS ?? '0';
  if (!/^[01]$/.test(rawProxyHops)) throw new Error('TRUST_PROXY_HOPS must be 0 or 1.');
  const proxyHops = Number(rawProxyHops) as 0 | 1;
  const origin = process.env.API_ORIGIN ?? 'http://localhost:3000';
  const parsedOrigin = new URL(origin);
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin !== origin)
    throw new Error('API_ORIGIN must be an exact HTTP or HTTPS origin.');
  const secureCookies = parsedOrigin.protocol === 'https:';
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!secureCookies && (!loopback || process.env.NODE_ENV === 'production'))
    throw new Error('HTTP is permitted only for loopback development.');

  exchange = await Exchange.open(databaseUrl, {
    allowFaultedStartup: true,
    migrations: process.env.NODE_ENV === 'production' ? 'verify' : 'apply',
  });
  simulator = new DemoMarket(exchange);
  app = await buildApi({
    exchange,
    auth: new AuthService(exchange),
    origin,
    secureCookies,
    logger: true,
    proxyHops,
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void close().catch(() => {
        console.error('Server shutdown failed; inspect database availability before restarting.');
        process.exitCode = 1;
      });
    });
  }
  await app.listen({ port, host });
  simulator.start();
  console.log(`Exchange sandbox API ready on port ${port}. Application origin: ${origin}.`);
  console.log('Virtual assets only. Run administrator setup before inviting traders.');
  console.log('Simulator intent is controlled by the administrator workspace.');
} catch (error) {
  if (error instanceof WriterUnavailableError)
    console.error('Another exchange process owns the writer. Stop it before starting this server.');
  else
    console.error(
      `Server startup failed (${safeCode(error)}). Check DATABASE_URL, API_ORIGIN, HOST, and PORT.`,
    );
  process.exitCode = 1;
  try {
    await close();
  } catch {
    console.error('Server cleanup could not be confirmed.');
  }
}
