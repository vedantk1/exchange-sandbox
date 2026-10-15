import { setTimeout as delay } from 'node:timers/promises';
import { AcceptanceJourneyError, openLoginPage } from '../../scripts/deploy/acceptance/journey.js';
import { test, expect } from './fixtures.js';

test('self-host login waits for anonymous session bootstrap beyond the standalone assertion default', async ({
  page,
  application,
}) => {
  let checks = 0;
  await page.route(`${application.origin}/api/auth/session`, async (route) => {
    checks += 1;
    await delay(5_200);
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ code: 'AUTHENTICATION_REQUIRED', message: 'Sign in to continue.' }),
    });
  });
  await openLoginPage(page, application.origin, 'ADMIN');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(checks).toBe(1);
});

test('self-host login reports an unexpected session status without exposing response details or retrying', async ({
  page,
  application,
}) => {
  const secret = 'PRIVATE_LOGIN_BOOTSTRAP_SENTINEL';
  let checks = 0;
  await page.route(`${application.origin}/api/auth/session`, async (route) => {
    checks += 1;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: secret, message: secret }),
    });
  });
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AcceptanceJourneyError);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_HTTP_503_FAILED',
    message: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_HTTP_503_FAILED',
  });
  expect(JSON.stringify(failure)).not.toContain(secret);
  expect((failure as Error).cause).toBeUndefined();
  expect(checks).toBe(1);
});

test('self-host login rejects a bad entry document without waiting for session bootstrap', async ({
  page,
  application,
}) => {
  let documents = 0;
  await page.route(`${application.origin}/login`, async (route) => {
    documents += 1;
    await route.fulfill({
      status: 503,
      contentType: 'text/html',
      body: '<!doctype html><p>Unavailable</p>',
    });
  });
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AcceptanceJourneyError);
  expect(failure).toMatchObject({ code: 'ACCEPTANCE_LOGIN_ADMIN_DOCUMENT_HTTP_503_FAILED' });
  expect((failure as Error).cause).toBeUndefined();
  expect(documents).toBe(1);
});
