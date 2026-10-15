import { test, expect, login } from './fixtures.js';

test('keyboard order review traps focus, preserves canceled edits, and submits only confirmed orders', async ({
  page,
  application,
}) => {
  await application.api.trader('keyboard_trader');
  await application.api.marketState('resume');
  await login(page, application.origin, 'keyboard_trader');
  const price = page.getByLabel(/^Limit price/);
  const quantity = page.getByLabel(/^Quantity/);
  const review = page.getByRole('button', { name: 'Review buy order', exact: true });
  await price.focus();
  await page.keyboard.type('40000');
  await page.keyboard.press('Tab');
  await expect(quantity).toBeFocused();
  await page.keyboard.type('0.1');
  await page.keyboard.press('Tab');
  await expect(review).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Review buy limit order', exact: true });
  const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Confirm buy order', exact: true });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(review).toBeFocused();
  await expect(price).toHaveValue('40000');
  await expect(quantity).toHaveValue('0.1');
  const before = await application.api.sql.query<{ count: string }>('SELECT count(*) FROM orders');
  expect(before.rows[0]?.count).toBe('0');

  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Back to edit', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(review).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  const order = page
    .getByRole('row')
    .filter({ has: page.getByRole('button', { name: 'Cancel', exact: true }) });
  await expect(order).toContainText('Open');
  const accepted = await application.api.sql.query<{ count: string }>(
    'SELECT count(*) FROM orders',
  );
  expect(accepted.rows[0]?.count).toBe('1');

  const cancel = order.getByRole('button', { name: 'Cancel', exact: true });
  await cancel.focus();
  await page.keyboard.press('Enter');
  const cancellation = page.getByRole('dialog', {
    name: 'Cancel remaining quantity?',
    exact: true,
  });
  await expect(
    cancellation.getByRole('button', { name: 'Close dialog', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(cancellation).not.toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(order).toContainText('Open');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  await expect(
    cancellation.getByRole('button', { name: 'Confirm cancellation', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cancellation).toContainText('Earlier fills are preserved');
  await page.keyboard.press('Escape');
  await expect(cancellation).not.toBeVisible();
  const canceled = await application.api.sql.query<{ status: string; reserved: string }>(
    'SELECT status, reserved_amount AS reserved FROM orders',
  );
  expect(canceled.rows).toEqual([{ status: 'CANCELED', reserved: '0' }]);
});

test('keyboard administrator confirmation traps focus and keeps the market unchanged until confirmed', async ({
  page,
  application,
}) => {
  await login(page, application.origin, 'operator');
  const resume = page.getByRole('button', { name: 'Resume trading', exact: true });
  await resume.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Resume trading', exact: true });
  const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
  const reason = dialog.getByLabel(/^Reason/);
  const keep = dialog.getByRole('button', { name: 'Keep unchanged', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Confirm action', exact: true });
  await expect(close).toBeFocused();
  await expect(confirm).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(reason).toBeFocused();
  await page.keyboard.type('Enable isolated keyboard trading demonstration');
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(resume).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.type('Keep the initial market state');
  await page.keyboard.press('Tab');
  await expect(keep).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  await expect(resume).toBeFocused();
  const before = await application.api.sql.query<{ market_state: string }>(
    'SELECT market_state FROM exchange_control',
  );
  expect(before.rows[0]?.market_state).toBe('PAUSED');

  await page.keyboard.press('Enter');
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.type('Confirm the keyboard market transition');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).not.toBeVisible();
  const pause = page.getByRole('button', { name: 'Pause trading', exact: true });
  await expect(pause).toBeEnabled();
  await expect(pause).toBeFocused();
  const after = await application.api.sql.query<{ market_state: string }>(
    'SELECT market_state FROM exchange_control',
  );
  expect(after.rows[0]?.market_state).toBe('TRADING');
});
