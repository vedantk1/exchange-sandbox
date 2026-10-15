import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import type {
  PreparedHistoryExportView,
  WorkspaceView,
} from '../../packages/contracts/src/index.js';
import { test, expect, login } from './fixtures.js';

async function reviewRollover(page: Page, sessionId: string) {
  await page.getByRole('button', { name: 'Start a new session', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Reason/).fill('Prepare another isolated demonstration');
  await dialog.getByRole('button', { name: 'Review session rollover' }).click();
  await expect(dialog).toContainText('Participants moving to the new session');
  await expect(dialog).toContainText('Remaining orders to cancel');
  await expect(dialog.getByRole('button', { name: 'Confirm new session' })).toBeDisabled();
  await dialog.getByLabel('Confirm current session ID').fill(sessionId);
  await dialog.getByRole('button', { name: 'Confirm new session' }).click();
}

test('reviewed rollover preserves final records and resets connected trader forms and balances', async ({
  page,
  browser,
  application,
}) => {
  const seller = await application.api.trader('seller');
  const buyer = await application.api.trader('buyer');
  await application.api.marketState('resume');
  await seller.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'SELL',
    quantity: '0.4',
    price: '50000',
  });
  await buyer.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'BUY',
    quantity: '0.1',
    price: '50000',
  });
  const traderContext = await browser.newContext();
  const traderPage = await traderContext.newPage();
  try {
    await login(traderPage, application.origin, 'seller');
    if (process.env.CAPTURE_PORTFOLIO_SCREENSHOTS === '1') {
      await mkdir('output/playwright/portfolio', { recursive: true });
      await traderPage.screenshot({
        path: 'output/playwright/portfolio/trading-workspace.png',
        fullPage: true,
      });
    }
    await traderPage.getByRole('button', { name: 'Sell', exact: true }).click();
    await traderPage.getByLabel(/^Limit price/).fill('51000');
    await traderPage.getByLabel(/^Quantity/).fill('0.2');
    await traderPage.getByRole('button', { name: 'Review sell order' }).click();
    await expect(traderPage.getByRole('dialog')).toBeVisible();
    await application.api.marketState('pause');
    await login(page, application.origin, 'operator');
    await reviewRollover(page, application.api.sessionId);
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText('A new trading session is ready.', { exact: true })).toBeVisible();
    await expect(
      traderPage.getByText('A new trading session is ready.', { exact: true }),
    ).toBeVisible();
    await expect(traderPage.getByRole('dialog')).not.toBeVisible();
    await expect(traderPage.getByLabel(/^Quantity/)).toHaveValue('');
    await expect(traderPage.getByRole('region', { name: 'Available balances' })).toContainText(
      '100,000.00',
    );
    await expect(traderPage.getByRole('region', { name: 'Available balances' })).toContainText(
      '1.0000',
    );
    await expect(traderPage.getByRole('button', { name: 'Review buy order' })).toBeDisabled();
    const current = (await seller.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(current.sessionId).not.toBe(application.api.sessionId);
    expect(current.marketState).toBe('PAUSED');
    expect(current.account?.openOrders).toHaveLength(0);
    expect(current.account?.balances['USD-SIM'].available).toBe('100000.000000000');
    const allocation = await application.api.sql.query<{
      accounts: string;
      minimum: string;
      maximum: string;
    }>(
      `SELECT count(*)::text AS accounts,min(allocations)::text AS minimum,max(allocations)::text AS maximum FROM (SELECT account_id,count(*) AS allocations FROM allocations WHERE session_id=$1 GROUP BY account_id) counted`,
      [current.sessionId],
    );
    expect(allocation.rows[0]).toMatchObject({ minimum: '1', maximum: '1' });
    await traderPage
      .getByRole('navigation', { name: 'Workspace navigation' })
      .getByRole('link', { name: 'History', exact: true })
      .click();
    await traderPage
      .getByLabel('Trading session', { exact: true })
      .selectOption(application.api.sessionId);
    await expect(
      traderPage.getByText('Archived session · read-only', { exact: true }),
    ).toBeVisible();
    await expect(
      traderPage.getByRole('table', { name: 'Selected session account balances' }),
    ).toContainText('104,995.00');
    await expect(
      traderPage.getByRole('table', { name: 'Selected session account balances' }),
    ).toContainText('0.9000');
    await traderPage
      .getByRole('group', { name: 'Session history views' })
      .getByRole('button', { name: 'Orders', exact: true })
      .click();
    const archivedOrder = traderPage.getByRole('row').filter({ hasText: 'Canceled' });
    await expect(archivedOrder).toContainText('0.1000');
    await expect(traderPage.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    if (process.env.CAPTURE_PORTFOLIO_SCREENSHOTS === '1') {
      await traderPage.getByRole('button', { name: 'Dismiss session change' }).click();
      await traderPage.getByRole('heading', { name: 'Sessions & history', exact: true }).click();
      await traderPage.screenshot({
        path: 'output/playwright/portfolio/archived-session.png',
        fullPage: true,
      });
    }
    await archivedOrder.getByRole('button').click();
    await expect(traderPage.getByRole('dialog')).toContainText('session ended');
    await expect(traderPage.getByRole('button', { name: 'Cancel remaining quantity' })).toHaveCount(
      0,
    );
    await traderPage.setViewportSize({ width: 390, height: 844 });
    await traderPage.keyboard.press('Escape');
    await expect(traderPage.getByRole('dialog')).not.toBeVisible();
    await expect(archivedOrder.getByRole('button')).toBeFocused();
    await expect(traderPage.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    await expect
      .poll(() =>
        traderPage.evaluate(
          () =>
            Math.max(document.body.scrollWidth, document.documentElement.scrollWidth) -
            window.innerWidth,
        ),
      )
      .toBeLessThanOrEqual(1);
    const historyBounds = await traderPage.locator('.session-history').boundingBox();
    const mainBounds = await traderPage.getByRole('main').boundingBox();
    expect(Math.abs(historyBounds!.width - mainBounds!.width)).toBeLessThanOrEqual(1);
    const sessionControl = traderPage.getByLabel('Trading session', { exact: true });
    await sessionControl.scrollIntoViewIfNeeded();
    await expect(sessionControl).toBeVisible();
    const sessionControlBounds = await sessionControl.boundingBox();
    expect(sessionControlBounds?.width).toBeGreaterThan(200);
    expect(sessionControlBounds?.width).toBeLessThanOrEqual(362);
    const exportButton = traderPage.getByRole('button', { name: 'Export consistent CSV' });
    await expect(exportButton).toBeVisible();
    const exportButtonBounds = await exportButton.boundingBox();
    expect(exportButtonBounds!.y).toBeGreaterThanOrEqual(
      sessionControlBounds!.y + sessionControlBounds!.height,
    );
    expect(Math.abs(exportButtonBounds!.width - sessionControlBounds!.width)).toBeLessThanOrEqual(
      1,
    );
    await expect(
      traderPage.getByRole('button', { name: 'Next records', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Sessions & history', exact: true }).click();
    await page
      .getByLabel('Trading session', { exact: true })
      .selectOption(application.api.sessionId);
    await expect(page.getByText('Archived session · read-only', { exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Session Rolled Over' })).toHaveCount(1);
  } finally {
    await traderContext.close();
  }
});

test('lost rollover acknowledgement recovers the original request after reload in the new session', async ({
  page,
  application,
}) => {
  await application.api.trader('participant');
  await login(page, application.origin, 'operator');
  const commands: Record<string, unknown>[] = [];
  let loseAcknowledgement = true;
  await page.route('**/api/receipts/*', (route) => route.abort('failed'));
  await page.route('**/api/admin/sessions/rollover', async (route) => {
    commands.push(route.request().postDataJSON() as Record<string, unknown>);
    const response = await route.fetch();
    if (loseAcknowledgement) {
      loseAcknowledgement = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await reviewRollover(page, application.api.sessionId);
  await expect(page.getByText('This command’s outcome is unknown', { exact: false })).toBeVisible();
  const next = (await application.api.admin.request('GET', '/api/workspace')).json<WorkspaceView>()
    .sessionId;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry same command' })).toBeEnabled();
  await page.unroute('**/api/receipts/*');
  await page.getByRole('button', { name: 'Retry same command' }).click();
  await expect(page.getByRole('button', { name: 'Retry same command' })).not.toBeVisible();
  await expect(
    page.getByText('starting allocations were issued once.', { exact: false }),
  ).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]?.sessionId).toBe(application.api.sessionId);
  const sessions = await application.api.sql.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM exchange_sessions',
  );
  expect(sessions.rows[0]?.count).toBe('2');
  expect(
    (await application.api.admin.request('GET', '/api/workspace')).json<WorkspaceView>().sessionId,
  ).toBe(next);
});

test('complete history paginates, finds older records, and downloads exact CSV from one boundary', async ({
  page,
  application,
}) => {
  const trader = await application.api.trader('historian');
  await application.api.marketState('resume');
  const ids: string[] = [];
  for (let index = 0; index < 27; index++) {
    const response = await trader.browser.request('POST', '/api/orders', {
      commandId: randomUUID(),
      sessionId: application.api.sessionId,
      side: 'BUY',
      quantity: '0.0001',
      price: '10000',
    });
    ids.push(response.json<{ order: { id: string } }>().order.id);
  }
  await login(page, application.origin, 'historian');
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'History', exact: true })
    .click();
  await page
    .getByRole('group', { name: 'Session history views' })
    .getByRole('button', { name: 'Orders', exact: true })
    .click();
  await page.getByLabel('Record side', { exact: true }).selectOption('BUY');
  await page
    .getByRole('group', { name: 'Session history views' })
    .getByRole('button', { name: 'Executions', exact: true })
    .click();
  await expect(page.getByText('No matching records', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page
    .getByRole('group', { name: 'Session history views' })
    .getByRole('button', { name: 'Orders', exact: true })
    .click();
  await expect(page.locator('tbody tr').filter({ hasText: 'Limit' })).toHaveCount(25);
  await page.getByRole('button', { name: 'Next records', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'Limit' })).toHaveCount(2);
  await expect(page.getByText('Page 2 · 25 records per page', { exact: true })).toBeVisible();
  await page.getByLabel('Find record by ID', { exact: true }).fill(ids[0]!);
  await expect(page.locator('tbody tr').filter({ hasText: 'Limit' })).toHaveCount(1);
  await expect(page.getByText('Page 1 · 25 records per page', { exact: true })).toBeVisible();
  const preparing = page.waitForResponse(
    (response) => response.url().endsWith('/exports') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Export consistent CSV' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Every file below comes from the same committed snapshot');
  const exportResponse = (await (await preparing).json()) as PreparedHistoryExportView;
  const orderFile = exportResponse.files.find((file) => file.name === 'orders.csv');
  expect(orderFile?.rows).toBe(27);
  expect(orderFile).not.toHaveProperty('content');
  expect(orderFile?.downloadUrl).toContain('/api/history/exports/');
  await expect(dialog).toContainText('27 rows');
  const downloading = page.waitForEvent('download');
  await dialog.getByRole('link', { name: 'orders.csv', exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('orders.csv');
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const downloaded = Buffer.concat(chunks).toString('utf8');
  expect(downloaded).toContain(ids[0]);
  expect(downloaded).toContain(ids[26]);
  expect(downloaded).toContain('0.0001');
  expect(downloaded.split('\n').length).toBe(29);
  await dialog.getByRole('button', { name: 'Prepare fresh export' }).click();
  await expect(page.getByRole('dialog')).toContainText('Download links expire in');
});
