import { expect as browserExpect, type Page } from '@playwright/test';
import type { DemoBrowser } from './browser.js';

const expect = browserExpect.configure({ timeout: 10_000 });

async function confirmAdmin(page: Page, reason: string) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Reason/).fill(reason);
  await dialog.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

/** Exercise what a reviewer receives, rather than a separate test-only application. */
export async function smokeDemo({ trader, admin }: DemoBrowser): Promise<void> {
  await expect(trader.getByRole('heading', { level: 1, name: 'BTC-SIM / USD-SIM' })).toBeVisible();
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('Control room');
  await expect(admin.getByRole('button', { name: 'Start simulator', exact: true })).toBeVisible();
  const partial = trader.getByRole('row').filter({ hasText: 'Partially Filled' });
  await expect(partial).toContainText('0.1000');
  await expect(partial).toContainText('0.4000');
  const balances = trader.getByRole('region', { name: 'Available balances' });
  await expect(balances).toContainText('0.3000 reserved');
  await partial.getByRole('button', { name: 'Cancel', exact: true }).click();
  await trader.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  const cancellation = trader.getByRole('dialog');
  await expect(cancellation).toContainText('Earlier fills are preserved');
  await cancellation.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(balances).toContainText('0.9000');
  await expect(balances).toContainText('0.0000 reserved');
  await expect(balances).toContainText('104,995.00');
  const navigation = trader.getByRole('navigation', { name: 'Workspace navigation' });
  await navigation.getByRole('link', { name: 'Orders', exact: true }).click();
  await expect(trader.getByRole('row').filter({ hasText: 'Canceled' })).toContainText('0.1000');
  await navigation.getByRole('link', { name: 'History', exact: true }).click();
  const fill = trader.getByRole('row').filter({ hasText: 'Maker' });
  await expect(fill).toContainText('0.1000');
  await expect(fill).toContainText('5.00');

  await admin.getByRole('button', { name: 'Pause trading', exact: true }).click();
  await confirmAdmin(admin, 'Verify the disposable reviewer demonstration');
  await admin.getByRole('button', { name: 'Start simulator', exact: true }).click();
  await confirmAdmin(admin, 'Inspect finite simulator inventory while paused');
  await expect(admin.getByRole('article', { name: 'Demo maker inventory' })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Fund demo maker', exact: true })).toBeEnabled();
  await admin.getByRole('button', { name: 'Stop simulator', exact: true }).click();
  await confirmAdmin(admin, 'Finish the disposable reviewer demonstration');
  await expect(admin.getByRole('button', { name: 'Start simulator', exact: true })).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Resume trading', exact: true })).toBeVisible();
}
