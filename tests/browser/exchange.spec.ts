import { randomUUID } from 'node:crypto';
import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { test, expect, login, confirmAdminAction, TEST_PASSWORD } from './fixtures.js';

test('invitation redemption leads to the trader workspace with starting balances', async ({
  page,
  application,
}) => {
  const invitation = await application.api.invite();
  await page.goto(`${application.origin}/join#token=${invitation.token}`);
  await expect(page).toHaveURL(`${application.origin}/join`);
  await page.getByLabel(/^Handle/).fill('new_trader');
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Create virtual trading account' }).click();
  await expect(page.getByRole('heading', { name: 'You’re ready to explore.' })).toBeVisible();
  await page.getByRole('link', { name: 'Continue to sign in' }).click();
  await page.getByLabel(/^Handle/).fill('new_trader');
  await page.getByLabel('Password', { exact: true }).fill(TEST_PASSWORD);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'BTC-SIM / USD-SIM' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText('1.0000');
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText(
    '100,000.00',
  );
  await expect(page.getByRole('button', { name: 'Review buy order' })).toBeDisabled();
  await expect(page.getByText('Trading is paused.', { exact: false })).toBeVisible();
});

test('partial fill, cancellation, balances and history agree through live updates', async ({
  page,
  application,
}) => {
  await application.api.trader('seller');
  const buyer = await application.api.trader('buyer');
  await application.api.marketState('resume');
  await login(page, application.origin, 'seller');
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await page.getByLabel(/^Limit price/).fill('50000');
  await page.getByLabel(/^Quantity/).fill('0.4');
  await page.getByRole('button', { name: 'Review sell order' }).click();
  await page.getByRole('button', { name: 'Confirm sell order' }).click();
  const order = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Cancel', exact: true }) });
  await expect(order).toContainText('Open');
  const fill = await buyer.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'BUY',
    quantity: '0.1',
    price: '50000',
  });
  expect(fill.json()).toMatchObject({ status: 'ACCEPTED' });
  await expect(order).toContainText('Partially Filled');
  await expect(order).toContainText('0.1000');
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText(
    '0.3000 reserved',
  );
  await order.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByRole('dialog')).toContainText('Earlier fills are preserved');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText('0.9000');
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText(
    '0.0000 reserved',
  );
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText(
    '104,995.00',
  );
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Canceled' })).toContainText('0.1000');
  await navigation.getByRole('link', { name: 'History', exact: true }).click();
  const execution = page.getByRole('row').filter({ hasText: 'Maker' });
  await expect(execution).toContainText('0.1000');
  await expect(execution).toContainText('5.00');
});

test('lost acknowledgement keeps one command identity across reload and reconnection', async ({
  page,
  context,
  application,
}) => {
  const trader = await application.api.trader('retry_trader');
  await application.api.marketState('resume');
  await login(page, application.origin, 'retry_trader');
  const commands: string[] = [];
  let loseAcknowledgement = true;
  await page.route('**/api/receipts/*', (route) => route.abort('failed'));
  await page.route('**/api/orders', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    commands.push((route.request().postDataJSON() as { commandId: string }).commandId);
    const response = await route.fetch();
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.getByLabel(/^Limit price/).fill('40000');
  await page.getByLabel(/^Quantity/).fill('0.1');
  await page.getByRole('button', { name: 'Review buy order' }).click();
  await page.getByRole('button', { name: 'Confirm buy order' }).click();
  await expect(page.getByText('This command’s outcome is unknown', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same command' })).toBeEnabled();
  await page.unroute('**/api/receipts/*');
  await page.getByRole('button', { name: 'Retry same command' }).click();
  await expect(page.getByRole('button', { name: 'Retry same command' })).not.toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toBe(commands[0]);
  const snapshot = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  expect(snapshot.account?.orders).toHaveLength(1);
  expect(snapshot.account?.balances['USD-SIM'].reserved).toBe('4004.000000000');
  await context.setOffline(true);
  await expect(page.getByText('Offline · submissions disabled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review buy order' })).toBeDisabled();
  await application.api.marketState('pause');
  await context.setOffline(false);
  await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
  await expect(page.getByText('Trading is paused.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review buy order' })).toBeDisabled();
});

test('administrator controls simulator, reviews inventory funding and resumes trading', async ({
  page,
  application,
}) => {
  await login(page, application.origin, 'operator');
  await page.getByRole('button', { name: 'Start simulator', exact: true }).click();
  await confirmAdminAction(page, 'Start the two-account browser demo');
  await expect(page.getByRole('button', { name: 'Stop simulator', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume trading', exact: true }).click();
  await confirmAdminAction(page, 'Enable simulated order matching');
  await application.simulator.tick();
  await expect(page.getByRole('button', { name: 'Pause trading', exact: true })).toBeVisible();
  const before = (
    await application.api.admin.request('GET', '/api/workspace')
  ).json<WorkspaceView>();
  expect(before.admin?.overview.demoMarket?.enabled).toBe(true);
  expect(before.market.trades.length).toBeGreaterThan(0);
  const makerInventory = page.getByRole('article', { name: 'Demo maker inventory' });
  await expect(makerInventory.getByRole('table')).toBeVisible();
  await expect(makerInventory.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Fund demo maker', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Pause trading', exact: true }).click();
  await confirmAdminAction(page, 'Review inventory before explicit funding');
  await page.getByRole('button', { name: 'Fund demo maker', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Amount', { exact: true }).fill('100');
  await dialog.getByLabel(/^Reason/).fill('Add explicit simulated maker inventory');
  await dialog.getByRole('button', { name: 'Review grant' }).click();
  await expect(dialog).toContainText('Available after grant');
  await dialog.getByRole('button', { name: 'Confirm grant' }).click();
  await expect(dialog).not.toBeVisible();
  const funded = (
    await application.api.admin.request('GET', '/api/workspace')
  ).json<WorkspaceView>();
  const originalFunds = before.admin!.overview.demoMarket!.inventory.maker.balances['USD-SIM'];
  const newFunds = funded.admin!.overview.demoMarket!.inventory.maker.balances['USD-SIM'];
  expect(
    BigInt(newFunds.total.replace('.', '')) - BigInt(originalFunds.total.replace('.', '')),
  ).toBe(100_000_000_000n);
  expect(newFunds.reserved).toBe(originalFunds.reserved);
  await page.getByRole('button', { name: 'Stop simulator', exact: true }).click();
  await confirmAdminAction(page, 'Stop and release automated order reservations');
  await expect(page.getByRole('button', { name: 'Start simulator', exact: true })).toBeVisible();
  const stopped = (
    await application.api.admin.request('GET', '/api/workspace')
  ).json<WorkspaceView>();
  expect(stopped.admin?.overview.demoMarket).toMatchObject({ enabled: false, status: 'STOPPED' });
  for (const inventory of Object.values(stopped.admin!.overview.demoMarket!.inventory)) {
    expect(inventory.balances['BTC-SIM'].reserved).toBe('0.0000');
    expect(inventory.balances['USD-SIM'].reserved).toBe('0.000000000');
  }
  const makerId = stopped.admin!.overview.demoMarket!.makerAccountId;
  const rows = await application.api.sql.query<{ orders: string; grants: string }>(
    `SELECT (SELECT COUNT(*) FROM orders WHERE account_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')) AS orders,
            (SELECT COUNT(*) FROM grants WHERE account_id = $1) AS grants`,
    [makerId],
  );
  expect(rows.rows[0]).toEqual({ orders: '0', grants: '1' });
  await page.getByRole('button', { name: 'Resume trading', exact: true }).click();
  await confirmAdminAction(page, 'Keep human trading open with automation stopped');
  await application.simulator.tick();
  const after = (
    await application.api.admin.request('GET', '/api/workspace')
  ).json<WorkspaceView>();
  expect(after.marketState).toBe('TRADING');
  expect(after.admin?.overview.demoMarket?.enabled).toBe(false);
  expect(after.market.trades).toHaveLength(stopped.market.trades.length);
});
