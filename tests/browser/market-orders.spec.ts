import { randomUUID } from 'node:crypto';
import type { CommandResult } from '../../apps/server/src/types.js';
import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { test, expect, login } from './fixtures.js';

test('a protected preview keeps its guard while liquidity changes and explains the partial fill', async ({
  page,
  application,
}) => {
  const maker = await application.api.trader('maker');
  const taker = await application.api.trader('taker');
  await application.api.marketState('resume');
  async function ask(quantity: string, price: string) {
    return (
      await maker.browser.request('POST', '/api/orders', {
        commandId: randomUUID(),
        sessionId: application.api.sessionId,
        side: 'SELL',
        quantity,
        price,
      })
    ).json<CommandResult>();
  }
  await ask('0.1', '50000');
  const removed = await ask('0.1', '50010');
  await login(page, application.origin, 'taker');
  await page.getByRole('button', { name: 'Protected market', exact: true }).click();
  await page.getByLabel(/^Quantity/).fill('0.2');
  await page.getByRole('button', { name: 'Review buy order' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Maximum buy price');
  await expect(review).toContainText('52,500.00');
  await expect(review).toContainText('5%');
  await expect(review).toContainText('Estimated fill');
  await expect(review).toContainText('0.2000');
  const canceled = await maker.browser.request('POST', `/api/orders/${removed.order!.id}/cancel`, {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
  });
  expect(canceled.json()).toMatchObject({ status: 'ACCEPTED' });
  await ask('0.1', '53000');
  await review.getByRole('button', { name: 'Confirm buy order' }).click();
  const outcome = page.getByRole('dialog');
  await expect(outcome).toContainText('Market order outcome');
  await expect(outcome).toContainText('Filled quantity');
  await expect(outcome).toContainText('0.1000 / 0.2000');
  await expect(outcome).toContainText('Canceled remainder');
  await expect(outcome).toContainText('Average execution price');
  await expect(outcome).toContainText('50,000.00');
  await expect(outcome).toContainText('Cumulative fee');
  await expect(outcome).toContainText('5.00');
  await expect(outcome).toContainText('next price exceeded your confirmed guard');
  await outcome.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText('94,995.00');
  await expect(page.getByRole('region', { name: 'Available balances' })).toContainText(
    '0.0000 reserved',
  );
  const snapshot = (await taker.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  expect(snapshot.account?.orders[0]).toMatchObject({
    type: 'MARKET',
    status: 'CANCELED',
    remaining: '0.1000',
    cancelReason: 'PRICE_GUARD_REACHED',
    reserved: '0.000000000',
  });
  expect(snapshot.account?.fills).toHaveLength(1);
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'Orders', exact: true })
    .click();
  const row = page.getByRole('row').filter({ hasText: 'Canceled' });
  await expect(row).toContainText('Protected market');
  await expect(row).toContainText('0.1000');
  await expect(row.getByRole('button', { name: 'Cancel', exact: true })).not.toBeVisible();
});

test('a preview expires after ten seconds and requires an explicit new preview and confirmation', async ({
  page,
  application,
}) => {
  const maker = await application.api.trader('maker');
  const taker = await application.api.trader('taker');
  await application.api.marketState('resume');
  await maker.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'BUY',
    quantity: '0.2',
    price: '50000',
  });
  await login(page, application.origin, 'taker');
  const previews: string[] = [];
  const commands: string[] = [];
  await page.route('**/api/orders/market/preview', async (route) => {
    const response = await route.fetch();
    previews.push(((await response.json()) as { previewId: string }).previewId);
    await route.fulfill({ response });
  });
  await page.route('**/api/orders/market', async (route) => {
    commands.push((route.request().postDataJSON() as { commandId: string }).commandId);
    await route.continue();
  });
  await page.getByRole('button', { name: 'Protected market', exact: true }).click();
  await page.getByRole('button', { name: 'Sell', exact: true }).click();
  await page.getByLabel(/^Quantity/).fill('0.1');
  await page.getByRole('button', { name: 'Review sell order' }).click();
  const review = page.getByRole('dialog');
  await expect(review).toContainText('Minimum sell price');
  await expect(review).toContainText('47,500.00');
  await expect(review.getByRole('button', { name: 'Confirm sell order' })).toBeEnabled();
  await expect(review).toContainText('Preview expired.', { timeout: 15_000 });
  await expect(review.getByRole('button', { name: 'Confirm sell order' })).toBeDisabled();
  expect(previews).toHaveLength(1);
  expect(commands).toHaveLength(0);
  expect(
    (await taker.browser.request('GET', '/api/workspace')).json<WorkspaceView>().account?.orders,
  ).toHaveLength(0);
  await review.getByRole('button', { name: 'Refresh preview', exact: true }).click();
  await expect(review.getByRole('button', { name: 'Confirm sell order' })).toBeEnabled();
  expect(previews).toHaveLength(2);
  expect(previews[1]).not.toBe(previews[0]);
  expect(commands).toHaveLength(0);
  await review.getByRole('button', { name: 'Confirm sell order' }).click();
  await expect(page.getByRole('dialog')).toContainText('Market order outcome');
  expect(commands).toHaveLength(1);
  expect(
    (await taker.browser.request('GET', '/api/workspace')).json<WorkspaceView>().account?.orders[0],
  ).toMatchObject({ type: 'MARKET', side: 'SELL', status: 'FILLED' });
});

test('lost market acknowledgement reloads and retries the same command after preview expiry', async ({
  page,
  application,
}) => {
  const maker = await application.api.trader('maker');
  const taker = await application.api.trader('taker');
  await application.api.marketState('resume');
  await maker.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'SELL',
    quantity: '0.2',
    price: '50000',
  });
  await login(page, application.origin, 'taker');
  const commands: Array<{ commandId: string; previewId: string }> = [];
  let expiresAt = '';
  let loseAcknowledgement = true;
  await page.route('**/api/receipts/*', (route) => route.abort('failed'));
  await page.route('**/api/orders/market/preview', async (route) => {
    const response = await route.fetch();
    expiresAt = ((await response.json()) as { expiresAt: string }).expiresAt;
    await route.fulfill({ response });
  });
  await page.route('**/api/orders/market', async (route) => {
    commands.push(route.request().postDataJSON() as { commandId: string; previewId: string });
    const response = await route.fetch();
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await page.getByRole('button', { name: 'Protected market', exact: true }).click();
  await page.getByLabel(/^Quantity/).fill('0.1');
  await page.getByRole('button', { name: 'Review buy order' }).click();
  await page.getByRole('button', { name: 'Confirm buy order' }).click();
  await expect(page.getByText('This command’s outcome is unknown', { exact: false })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same command' })).toBeEnabled();
  await application.api.sql.query(
    'SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.05)',
    [expiresAt],
  );
  await page.unroute('**/api/receipts/*');
  await page.getByRole('button', { name: 'Retry same command' }).click();
  await expect(page.getByRole('button', { name: 'Retry same command' })).not.toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('Market order outcome');
  await expect(page.getByRole('dialog')).toContainText('0.1000 / 0.1000');
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  const snapshot = (await taker.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  expect(snapshot.account?.orders).toHaveLength(1);
  expect(snapshot.account?.fills).toHaveLength(1);
  expect(snapshot.account?.balances['USD-SIM']).toEqual({
    available: '94995.000000000',
    reserved: '0.000000000',
    total: '94995.000000000',
  });
});
