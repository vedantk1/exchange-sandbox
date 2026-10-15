import type { Page } from '@playwright/test';
import { test, expect, login, TEST_PASSWORD } from './fixtures.js';

// Recovery handoffs contain generated one-use secrets. Keep this suite's failure
// report to assertions; do not retain browser screenshots or network traces.
test.use({ trace: 'off', screenshot: 'off' });
test.afterEach(async ({ page }) => {
  // Playwright can attach an automatic DOM error context even with traces off.
  // Remove private handoff content before the page fixture collects that context.
  await page.goto('about:blank').catch(() => page.close().catch(() => undefined));
});

const ROTATED_PASSWORD = 'rotation-browser-test-password';
const RECOVERED_PASSWORD = 'recovery-browser-test-password';

async function signIn(page: Page, origin: string, handle: string, password: string): Promise<void> {
  await page.goto(`${origin}/login`);
  await page.getByLabel(/^Handle/).fill(handle);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function openRecovery(page: Page, link: string): Promise<void> {
  try {
    await page.goto(link);
  } catch {
    // Navigation errors can include the secret-bearing fragment in their URL.
    throw new Error('The browser recovery page could not be opened.');
  }
  await expect.poll(() => new URL(page.url()).hash === '').toBe(true);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
}

test('password rotation preserves this browser, revokes other sessions, and requires the new password', async ({
  page,
  browser,
  context,
  application,
}) => {
  const trader = await application.api.trader('rotation_trader');
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await login(page, application.origin, 'rotation_trader');
    await login(other, application.origin, 'rotation_trader');
    const originalSession = (await context.cookies(application.origin)).find(
      (cookie) => cookie.name === 'sandbox_session',
    )?.value;
    await page.getByRole('button', { name: 'Account settings for rotation_trader' }).click();
    const dialog = page.getByRole('dialog', { name: 'Account settings' });
    await expect(dialog).toContainText('keeps this browser signed in');
    await dialog.getByLabel('Current password', { exact: true }).fill(TEST_PASSWORD);
    await dialog.getByLabel('New password', { exact: true }).fill(ROTATED_PASSWORD);
    await dialog.getByLabel('Confirm new password', { exact: true }).fill(ROTATED_PASSWORD);
    await dialog.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Password changed. Other sessions were revoked.' }),
    ).toBeVisible();
    expect((await page.request.get(`${application.origin}/api/auth/session`)).status()).toBe(200);
    const currentSession = (await context.cookies(application.origin)).find(
      (cookie) => cookie.name === 'sandbox_session',
    )?.value;
    // Rotation replaces the bearer token while preserving this browser's access.
    expect(
      Boolean(originalSession) && Boolean(currentSession) && currentSession !== originalSession,
    ).toBe(true);
    expect((await trader.browser.request('GET', '/api/auth/session')).statusCode).toBe(401);
    await expect(other.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await other.request.get(`${application.origin}/api/auth/session`)).status()).toBe(401);

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await signIn(page, application.origin, 'rotation_trader', TEST_PASSWORD);
    await expect(page.getByRole('alert')).toContainText('The handle or password is incorrect.');
    await page.getByLabel('Password', { exact: true }).fill(ROTATED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Account settings for rotation_trader' }),
    ).toBeVisible();
  } finally {
    await otherContext.close();
  }
});

test('administrator recovery is single use, revokes existing sessions, and restores access with a new password', async ({
  page,
  browser,
  application,
}) => {
  const trader = await application.api.trader('recovery_participant');
  const activeContext = await browser.newContext();
  const recoveryContext = await browser.newContext();
  try {
    const active = await activeContext.newPage();
    const recovery = await recoveryContext.newPage();
    await login(active, application.origin, 'recovery_participant');
    await login(page, application.origin, 'operator');
    await page
      .getByRole('navigation', { name: 'Administrator views' })
      .getByRole('button', { name: /^Participants/ })
      .click();
    await page.getByLabel('Find participant by handle or account ID').fill('recovery_participant');
    await page.getByRole('button', { name: '@recovery_participant active', exact: true }).click();
    await page.getByRole('button', { name: 'Recovery link', exact: true }).click();
    const review = page.getByRole('dialog', { name: 'Create recovery link', exact: true });
    await review.getByLabel(/^Reason/).fill('Restore this isolated browser test participant');
    await review.getByRole('button', { name: 'Confirm action', exact: true }).click();
    await expect(review).not.toBeVisible();
    const secret = page.getByRole('dialog', { name: 'Recovery link ready' });
    const link = await secret.getByLabel('Single-use link', { exact: true }).inputValue();
    expect(
      new URL(link).origin === application.origin && new URL(link).pathname === '/recover',
    ).toBe(true);
    await secret.getByRole('button', { name: 'Close and discard link', exact: true }).click();
    await expect(secret).not.toBeVisible();
    // Issuing a handoff alone must not revoke an active session.
    expect((await active.request.get(`${application.origin}/api/auth/session`)).status()).toBe(200);

    await openRecovery(recovery, link);
    await recovery.getByLabel('New password', { exact: true }).fill(RECOVERED_PASSWORD);
    await recovery.getByLabel('Confirm password', { exact: true }).fill(RECOVERED_PASSWORD);
    await recovery.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(
      recovery.getByRole('heading', { name: 'Your password is updated.', exact: true }),
    ).toBeVisible();
    expect((await recovery.request.get(`${application.origin}/api/auth/session`)).status()).toBe(
      401,
    );
    expect((await trader.browser.request('GET', '/api/auth/session')).statusCode).toBe(401);
    expect((await page.request.get(`${application.origin}/api/auth/session`)).status()).toBe(200);
    await expect(active.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    expect((await active.request.get(`${application.origin}/api/auth/session`)).status()).toBe(401);

    await openRecovery(recovery, link);
    await recovery
      .getByLabel('New password', { exact: true })
      .fill('second-recovery-attempt-password');
    await recovery
      .getByLabel('Confirm password', { exact: true })
      .fill('second-recovery-attempt-password');
    await recovery.getByRole('button', { name: 'Update password', exact: true }).click();
    await expect(recovery.getByRole('alert')).toContainText(
      'invalid, expired, revoked, or already used',
    );
    await signIn(recovery, application.origin, 'recovery_participant', TEST_PASSWORD);
    await expect(recovery.getByRole('alert')).toContainText('The handle or password is incorrect.');
    await recovery.getByLabel('Password', { exact: true }).fill(RECOVERED_PASSWORD);
    await recovery.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(recovery.getByText('Live · synced', { exact: true })).toBeVisible();
    await expect(
      recovery.getByRole('button', { name: 'Account settings for recovery_participant' }),
    ).toBeVisible();
  } finally {
    await recoveryContext.close();
    await activeContext.close();
  }
});
