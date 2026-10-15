import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DemoMarket } from '../../apps/server/src/demo-market/service.js';
import { createApiFixture } from '../../tests/helpers/api.js';

if (process.env.PORTFOLIO_OWNED_DATABASE !== '1')
  throw new Error('Start the isolated demonstration with pnpm portfolio:serve.');

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('No demonstration port available.');
  return address.port;
}

async function stopWeb(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const fixture = await createApiFixture({ origin });
const simulator = new DemoMarket(fixture.exchange);
let web: ChildProcess | undefined;
let webFailed = false;
let privateDirectory: string | undefined;
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  const seller = await fixture.trader('demo_seller');
  const buyer = await fixture.trader('demo_buyer');
  await fixture.marketState('resume');
  for (const [participant, side, quantity] of [
    [seller, 'SELL', '0.4'],
    [buyer, 'BUY', '0.1'],
  ] as const) {
    const result = await participant.browser.request('POST', '/api/orders', {
      commandId: randomUUID(),
      sessionId: fixture.sessionId,
      side,
      quantity,
      price: '50000',
    });
    if (result.json().status !== 'ACCEPTED') throw new Error('Demonstration setup failed.');
  }
  await mkdir('output/playwright', { recursive: true });
  privateDirectory = await mkdtemp('output/playwright/portfolio-private-');
  // Browser state is a private capability, not a showcase artifact. Cleanup owns this directory only.
  for (const [name, browser] of [
    ['trader', seller.browser],
    ['admin', fixture.admin],
  ] as const) {
    const cookies = browser.cookieHeader.split('; ').map((pair) => {
      const boundary = pair.indexOf('=');
      const name = pair.slice(0, boundary);
      return {
        name,
        value: pair.slice(boundary + 1),
        domain: '127.0.0.1',
        path: '/',
        expires: -1,
        httpOnly: name === 'sandbox_session',
        secure: false,
        sameSite: 'Strict',
      };
    });
    await writeFile(`${privateDirectory}/${name}.json`, JSON.stringify({ cookies, origins: [] }), {
      mode: 0o600,
    });
  }
  const apiOrigin = await fixture.listen();
  web = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
    cwd: 'apps/web',
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: new URL(apiOrigin).port,
      WEB_PORT: String(port),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  web.stderr?.resume();
  const webFailure = () => {
    if (!interrupted.signal.aborted) {
      webFailed = true;
      interrupt();
    }
  };
  web.once('exit', webFailure);
  web.once('error', webFailure);
  const deadline = Date.now() + 20_000;
  while (true) {
    interrupted.signal.throwIfAborted();
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.ok) break;
    } catch {
      /* Vite is starting. */
    }
    if (Date.now() >= deadline) throw new Error('Demonstration UI startup timed out.');
    await delay(100, undefined, { signal: interrupted.signal });
  }
  simulator.start();
  console.log(`Isolated development demonstration: ${origin}`);
  console.log(
    `Private browser state: ${privateDirectory}/trader.json and ${privateDirectory}/admin.json`,
  );
  console.log(
    'Setup: 0.4 sell / 0.1 buy at 50,000; simulator stopped. No trading timestamps were changed.',
  );
  console.log(
    'Load the private state in an isolated browser profile. Stop with Ctrl+C to remove the fixture and private state.',
  );
  if (!interrupted.signal.aborted)
    await new Promise<void>((resolve) =>
      interrupted.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
} catch {
  if (!interrupted.signal.aborted) {
    console.error(
      'The isolated demonstration could not start. Cleanup will remove its private state.',
    );
    process.exitCode = 1;
  }
} finally {
  if (webFailed) {
    console.error('The demonstration development server stopped unexpectedly.');
    process.exitCode = 1;
  }
  try {
    try {
      if (web) await stopWeb(web);
    } finally {
      try {
        await simulator.close();
      } finally {
        try {
          try {
            await fixture.dispose();
          } catch (error) {
            // A terminal interrupt also reaches the owned PostgreSQL process.
            // Its wrapper removes that whole cluster after this child exits.
            const code = (error as { code?: string }).code;
            if (
              !interrupted.signal.aborted ||
              !['57P01', '57P03', 'ECONNREFUSED'].includes(code ?? '')
            )
              throw error;
          }
        } finally {
          if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
        }
      }
    }
  } catch {
    console.error('Demonstration cleanup did not complete. Inspect its private output directory.');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
