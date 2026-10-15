import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { DemoMarket } from '../../apps/server/src/demo-market/service.js';
import { createApiFixture, type ApiFixture } from '../../tests/helpers/api.js';
import { demoCookies, openDemoBrowser, type DemoBrowser } from './browser.js';
import { PortfolioError, portfolioOptions } from './options.js';
import { smokeDemo } from './smoke.js';

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

let fixture: ApiFixture | undefined;
let simulator: DemoMarket | undefined;
let browser: DemoBrowser | undefined;
let web: ChildProcess | undefined;
let webFailed = false;
let privateDirectory: string | undefined;
const interrupted = new AbortController();
const interrupt = () => interrupted.abort();
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  const options = portfolioOptions(process.argv.slice(2));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  interrupted.signal.throwIfAborted();
  fixture = await createApiFixture({ origin });
  simulator = new DemoMarket(fixture.exchange);
  interrupted.signal.throwIfAborted();
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
  if (options.noOpen) {
    await mkdir('output/playwright', { recursive: true });
    privateDirectory = await mkdtemp('output/playwright/portfolio-private-');
    // Capture-only capabilities are explicitly requested and never published.
    for (const [name, client] of [
      ['trader', seller.browser],
      ['admin', fixture.admin],
    ] as const)
      await writeFile(
        `${privateDirectory}/${name}.json`,
        JSON.stringify({ cookies: demoCookies(client.cookieHeader, origin), origins: [] }),
        { mode: 0o600 },
      );
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
    'Setup: 0.4 sell / 0.1 buy at 50,000; simulator stopped. No trading timestamps were changed.',
  );
  if (options.noOpen) {
    console.log(
      `Capture-only private browser state: ${privateDirectory}/trader.json and ${privateDirectory}/admin.json`,
    );
    console.log('Stop with Ctrl+C to remove the fixture and private capture state.');
  } else {
    browser = await openDemoBrowser({
      origin,
      traderCookie: seller.browser.cookieHeader,
      adminCookie: fixture.admin.cookieHeader,
      headless: options.headless,
      signal: interrupted.signal,
      onClose: interrupt,
    });
    if (options.smoke) {
      await smokeDemo(browser);
      console.log(
        'Reviewer demonstration passed: trader, cancellation, history and admin controls.',
      );
      interrupt();
    } else {
      console.log(
        'Trader and administrator are signed in separately. Close either demo window or press Ctrl+C to remove all demo resources.',
      );
    }
  }
  if (!interrupted.signal.aborted)
    await new Promise<void>((resolve) =>
      interrupted.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
} catch (error) {
  if (!interrupted.signal.aborted) {
    if (error instanceof PortfolioError) {
      console.error(`The isolated demonstration failed (${error.code}).`);
      if (error.code === 'PORTFOLIO_BROWSER_NOT_INSTALLED')
        console.error('Install the demo browser with: pnpm exec playwright install chromium');
      else if (error.code === 'PORTFOLIO_BROWSER_LAUNCH_FAILED')
        console.error(
          'Install Chromium with pnpm exec playwright install chromium and use a desktop display. For automated verification, use: pnpm portfolio:serve --headless --smoke',
        );
      else if (error.code === 'PORTFOLIO_ARGUMENTS_INVALID')
        console.error('Usage: pnpm portfolio:serve [--headless --smoke | --no-open]');
    } else
      console.error(
        'The isolated demonstration could not complete. Its owned resources will close.',
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
      await browser?.close();
    } finally {
      try {
        if (web) await stopWeb(web);
      } finally {
        try {
          await simulator?.close();
        } finally {
          try {
            try {
              await fixture?.dispose();
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
    }
  } catch {
    console.error('Demonstration cleanup did not complete. Inspect its private output directory.');
    process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
