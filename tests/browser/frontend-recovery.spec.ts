import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { test, expect, login, TEST_PASSWORD } from './fixtures.js';

test('a failed lazy module keeps the original unresolved command and reload resolves it once', async ({
  page,
  application,
}) => {
  const trader = await application.api.trader('recovery_trader');
  const otherTrader = await application.api.trader('other_trader');
  await application.api.marketState('resume');
  await login(page, application.origin, 'recovery_trader');
  const commands: string[] = [];
  await page.route('**/api/receipts/*', (route) => route.abort('failed'));
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    commands.push((route.request().postDataJSON() as { commandId: string }).commandId);
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'ACCEPTED' });
    await route.abort('failed');
  });
  await page.getByLabel(/^Limit price/).fill('40000');
  await page.getByLabel(/^Quantity/).fill('0.1');
  await page.getByRole('button', { name: 'Review buy order' }).click();
  await page.getByRole('button', { name: 'Confirm buy order' }).click();
  await expect(page.getByText('This command’s outcome is unknown', { exact: false })).toBeVisible();
  const storageKey = `sandbox.pending.v1.${trader.user.accountId}`;
  const saved = await page.evaluate((key) => sessionStorage.getItem(key), storageKey);
  expect(JSON.parse(saved!)).toMatchObject({
    actorId: trader.user.accountId,
    body: { commandId: commands[0], sessionId: application.api.sessionId },
  });

  // Remove the next lazy module as a deployment can remove an old, hashed asset.
  const historyModule = /\/src\/history\/SessionHistory\.tsx(?:\?|$)/;
  let failedLoads = 0;
  await page.route(historyModule, (route) => {
    failedLoads += 1;
    return route.abort('failed');
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let navigations = 0;
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navigations += 1;
  });
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'History', exact: true })
    .click();
  const heading = page.getByRole('heading', { name: 'Workspace interrupted' });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByRole('main')).toContainText(
    'Reloading does not create or resend an order',
  );
  await expect(page.getByRole('main')).not.toContainText(trader.user.accountId);
  await expect(page.getByRole('main')).not.toContainText('recovery_trader');
  expect(failedLoads).toBe(1);
  expect(pageErrors).toHaveLength(0);
  const navigationsBeforeReload = navigations;
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(saved);

  // Another tab can change this origin's cookie while the broken interface is unmounted.
  const changedAccount = await page.request.post(`${application.origin}/api/auth/login`, {
    headers: { Origin: application.origin },
    data: { handle: 'other_trader', password: TEST_PASSWORD },
  });
  expect(changedAccount.status()).toBe(200);
  const recoveredActors: Array<string | undefined> = [];
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/receipts/${commands[0]}`)) {
      recoveredActors.push(request.headers()['x-sandbox-actor']);
    }
  });
  await page.unroute(historyModule);
  await page.unroute('**/api/receipts/*');
  await page.getByRole('button', { name: 'Reload workspace', exact: true }).click();
  await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workspace interrupted' })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry same command' })).not.toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Account settings for other_trader' }),
  ).toBeVisible();
  expect(recoveredActors).toHaveLength(0);
  expect(await page.evaluate((key) => sessionStorage.getItem(key), storageKey)).toBe(saved);
  const otherSnapshot = (
    await otherTrader.browser.request('GET', '/api/workspace')
  ).json<WorkspaceView>();
  expect(otherSnapshot.account?.orders).toHaveLength(0);
  expect(navigations).toBe(navigationsBeforeReload + 1);

  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  // A recovered receipt can finish while the initial snapshot is still in
  // flight. Force that ordering instead of depending on local query timing.
  let releaseWorkspace!: () => void;
  let releaseReceipt!: () => void;
  const workspaceGate = new Promise<void>((resolve) => (releaseWorkspace = resolve));
  const receiptGate = new Promise<void>((resolve) => (releaseReceipt = resolve));
  let workspaceHeld = false;
  let receiptHeld = false;
  await page.route('**/api/workspace', async (route) => {
    const response = await route.fetch();
    workspaceHeld = true;
    await workspaceGate;
    await route.fulfill({ response });
  });
  await page.route(`**/api/receipts/${commands[0]}`, async (route) => {
    const response = await route.fetch();
    receiptHeld = true;
    await receiptGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`${application.origin}/login`);
    await page.getByLabel(/^Handle/).fill('recovery_trader');
    await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect.poll(() => workspaceHeld && receiptHeld).toBe(true);
    releaseReceipt();
    await expect(page.getByText('Command confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Live · synced', { exact: true })).not.toBeVisible();
    releaseWorkspace();
    await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
  } finally {
    releaseReceipt();
    releaseWorkspace();
    await page.unroute('**/api/workspace');
    await page.unroute(`**/api/receipts/${commands[0]}`);
  }
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), storageKey))
    .toBeNull();
  expect(recoveredActors).toEqual([trader.user.accountId]);
  expect(commands).toHaveLength(1);
  const snapshot = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  expect(snapshot.account?.orders).toHaveLength(1);
  expect(snapshot.account?.balances['USD-SIM'].reserved).toBe('4004.000000000');
  const records = await application.api.sql.query<{ orders: string; receipts: string }>(
    `SELECT (SELECT count(*) FROM orders WHERE account_id = $1) AS orders,
            (SELECT count(*) FROM receipts WHERE actor_id = $1 AND command_id = $2) AS receipts`,
    [trader.user.accountId, commands[0]],
  );
  expect(records.rows[0]).toEqual({ orders: '1', receipts: '1' });
});
