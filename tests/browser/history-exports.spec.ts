import type { PreparedHistoryExportView } from '../../packages/contracts/src/index.js';
import { test, expect, login } from './fixtures.js';

test('export preparation can be retried and expired links offer a fresh snapshot', async ({
  page,
  application,
}) => {
  await application.api.trader('export_reader');
  await login(page, application.origin, 'export_reader');
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'History', exact: true })
    .click();
  let attempts = 0;
  const exportIds: string[] = [];
  await page.route('**/api/history/*/exports', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ code: 'EXPORT_BUSY', message: 'Export capacity is busy. Retry.' }),
      });
      return;
    }
    const response = await route.fetch();
    const value = (await response.json()) as PreparedHistoryExportView;
    exportIds.push(value.exportId);
    // Exercise client-side expiry without waiting for the server's five-minute retention.
    await route.fulfill({
      response,
      json: {
        ...value,
        expiresAt: new Date(Date.now() + (attempts === 2 ? 1_000 : 300_000)).toISOString(),
      },
    });
  });
  const prepare = page.getByRole('button', { name: 'Export consistent CSV', exact: true });
  await prepare.click();
  await expect(page.getByRole('alert')).toContainText('Export capacity is busy. Retry.');
  await expect(prepare).toBeEnabled();
  await prepare.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('These download links have expired.');
  await expect(dialog.getByRole('link', { name: 'orders.csv', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Prepare fresh export', exact: true }).click();
  await expect(
    page.getByRole('dialog').getByRole('link', { name: 'orders.csv', exact: true }),
  ).toBeVisible();
  expect(exportIds).toHaveLength(2);
  expect(exportIds[0]).not.toBe(exportIds[1]);
});

test('administrator exports explain account data and session-wide audit scope', async ({
  page,
  application,
}) => {
  await application.api.trader('export_participant');
  await login(page, application.origin, 'operator');
  await page.getByRole('button', { name: 'Sessions & history', exact: true }).click();
  await page.getByRole('button', { name: /@export_participant/ }).click();
  await page.getByRole('button', { name: 'Export consistent CSV', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    'Entire selected session, including actions for other accounts.',
  );
  await expect(dialog.getByRole('link', { name: 'audit.csv', exact: true })).toBeVisible();
  await expect(dialog).toContainText('Sign in is required for each download.');
});
