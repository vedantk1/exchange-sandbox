import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { test as base, expect, type Page } from '@playwright/test';
import { DemoMarket } from '../../apps/server/src/demo-market/service.js';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';

interface BrowserApplication {
  api: ApiFixture;
  origin: string;
  simulator: DemoMarket;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  if (!address || typeof address === 'string') throw new Error('No browser test port available.');
  return address.port;
}

async function waitForWeb(origin: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error('The browser test development server exited before startup.');
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Vite is still starting. There is no dependency on the user's running app.
    }
    await delay(100);
  }
  throw new Error('The browser test development server did not become ready.');
}

async function stopWeb(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(deadline);
  }
}

export const test = base.extend<{ application: BrowserApplication }>({
  application: async ({}, use) => {
    const webPort = await freePort();
    const origin = `http://127.0.0.1:${webPort}`;
    const api = await createApiFixture({ origin });
    const simulator = new DemoMarket(api.exchange);
    let web: ChildProcess | undefined;
    try {
      const apiOrigin = await api.listen();
      web = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], {
        cwd: 'apps/web',
        env: {
          ...process.env,
          NODE_ENV: 'development',
          PORT: new URL(apiOrigin).port,
          WEB_PORT: String(webPort),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      // Drain stderr without including local machine paths in test reports.
      web.stderr?.resume();
      await waitForWeb(origin, web);
      await use({ api, origin, simulator });
    } finally {
      try {
        if (web) await stopWeb(web);
      } finally {
        try {
          await simulator.close();
        } finally {
          await api.dispose();
        }
      }
    }
  },
});

export { expect, TEST_PASSWORD };

export async function login(page: Page, origin: string, handle: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByLabel(/^Handle/).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
}

export async function confirmAdminAction(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Reason/).fill(reason);
  await dialog.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
