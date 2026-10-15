import { randomUUID } from 'node:crypto';
import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { test, expect, login } from './fixtures.js';

test('keyboard candle data follows real executions with exact prices and volume on narrow screens', async ({
  page,
  application,
}) => {
  const seller = await application.api.trader('chart_reader');
  const buyer = await application.api.trader('chart_buyer');
  await login(page, application.origin, 'chart_reader');
  const visualChart = page.locator('.trader-chart-canvas');
  await expect(visualChart).toHaveAttribute('aria-hidden', 'true');
  await expect(visualChart.locator('a[href]')).toHaveAttribute('tabindex', '-1');
  await expect(
    page.getByRole('link', { name: 'Charts by TradingView', exact: true }),
  ).toBeVisible();
  const disclosure = page.locator('summary').filter({ hasText: 'View candle data' });
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('No candle data is available until orders execute.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Candle data · UTC' })).toHaveCount(0);

  await application.api.marketState('resume');
  const sell = await seller.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'SELL',
    quantity: '0.4',
    price: '50000.01',
  });
  expect(sell.json().status).toBe('ACCEPTED');
  const buy = await buyer.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'BUY',
    quantity: '0.1001',
    price: '50000.01',
  });
  expect(buy.json().status).toBe('ACCEPTED');
  const workspace = (await seller.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  expect(workspace.market.candles).toHaveLength(1);
  expect(workspace.market.candles[0]).toMatchObject({
    open: '50000.01',
    high: '50000.01',
    low: '50000.01',
    close: '50000.01',
    volume: '0.1001',
  });
  const table = page.getByRole('table', { name: 'Candle data · UTC' });
  await expect(table).toBeVisible();
  const row = table.getByRole('row').nth(1);
  await expect(row.getByRole('cell')).toHaveText([
    '50,000.01',
    '50,000.01',
    '50,000.01',
    '50,000.01',
    '0.1001',
  ]);
  await expect(row.getByRole('rowheader')).toHaveText(
    new Date(workspace.market.candles[0]!.timestamp).toISOString().slice(0, 16).replace('T', ' '),
  );
  await expect(page.getByText('Only one minute has trades', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await disclosure.focus();
  await page.keyboard.press('Tab');
  const scroll = page.getByRole('region', { name: 'Candle data · UTC' });
  await expect(scroll).toBeFocused();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth))
    .toBeLessThanOrEqual(1);
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollWidth - element.clientWidth))
    .toBeGreaterThan(0);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => scroll.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(table).not.toBeVisible();
});
