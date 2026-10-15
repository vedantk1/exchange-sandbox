import type { Page, Request } from '@playwright/test';
import { openLoginPage } from '../../scripts/deploy/acceptance/login.js';
import { submitLogin } from '../../scripts/deploy/acceptance/submission.js';
import { test, expect, TEST_PASSWORD } from './fixtures.js';

function listeners(page: Page) {
  const emitter = page as unknown as { listenerCount(event: string): number };
  return ['request', 'response', 'requestfailed'].map((event) => emitter.listenerCount(event));
}

test('self-host submission signs in through the real controlled form without retrying', async ({
  page,
  application,
}) => {
  await openLoginPage(page, application.origin, 'ADMIN');
  const before = listeners(page);
  let attempts = 0;
  const requested = (request: Request) => {
    if (request.url() === `${application.origin}/api/auth/login` && request.method() === 'POST')
      attempts++;
  };
  page.on('request', requested);
  await submitLogin(page, application.origin, 'ADMIN', 'operator', TEST_PASSWORD);
  page.off('request', requested);
  await expect(page.getByText('Live · synced', { exact: true })).toBeVisible();
  expect(attempts).toBe(1);
  expect(listeners(page)).toEqual(before);
});

test('self-host submission classifies a login transport reset without exposing private values', async ({
  page,
  application,
}) => {
  await openLoginPage(page, application.origin, 'ADMIN');
  const before = listeners(page);
  let attempts = 0;
  await page.route(`${application.origin}/api/auth/login`, async (route) => {
    attempts++;
    await route.abort('connectionreset');
  });
  const failure = await submitLogin(
    page,
    application.origin,
    'ADMIN',
    'operator',
    TEST_PASSWORD,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_POST_REQUEST_FAILED_CONNECTION_RESET_FAILED',
    submissionCheckpoint: { request: 'FAILED', requestFailure: 'CONNECTION_RESET' },
  });
  expect(attempts).toBe(1);
  expect(JSON.stringify(failure)).not.toContain(application.origin);
  expect(JSON.stringify(failure)).not.toContain(TEST_PASSWORD);
  expect(listeners(page)).toEqual(before);
});

test('self-host submission reports an HTTP failure without retaining response text or retrying', async ({
  page,
  application,
}) => {
  const sentinel = 'PRIVATE_LOGIN_SUBMISSION_SENTINEL';
  await openLoginPage(page, application.origin, 'ADMIN');
  const before = listeners(page);
  let attempts = 0;
  await page.route(`${application.origin}/api/auth/login`, async (route) => {
    attempts++;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ code: sentinel, message: sentinel }),
    });
  });
  const failure = await submitLogin(
    page,
    application.origin,
    'ADMIN',
    'operator',
    TEST_PASSWORD,
  ).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_POST_HTTP_503_FAILED',
    submissionCheckpoint: { request: 'RESPONDED', httpStatus: 503 },
  });
  expect(JSON.stringify(failure)).not.toContain(sentinel);
  expect(attempts).toBe(1);
  expect(listeners(page)).toEqual(before);
});

test('self-host submission distinguishes native form invalidity from a pending login request', async ({
  page,
  application,
}) => {
  await openLoginPage(page, application.origin, 'ADMIN');
  const before = listeners(page);
  let attempts = 0;
  const requested = (request: Request) => {
    if (request.url() === `${application.origin}/api/auth/login` && request.method() === 'POST')
      attempts++;
  };
  page.on('request', requested);
  await page.getByLabel('Password', { exact: true }).evaluate((input) => {
    (input as HTMLInputElement).setCustomValidity('PRIVATE_NATIVE_VALIDITY_SENTINEL');
  });
  const failure = await submitLogin(
    page,
    application.origin,
    'ADMIN',
    'operator',
    TEST_PASSWORD,
  ).catch((error: unknown) => error);
  page.off('request', requested);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_POST_NOT_REQUESTED_FAILED',
    submissionCheckpoint: {
      stage: 'POST_RESPONSE',
      request: 'NOT_REQUESTED',
      inputStateAvailable: true,
      documentReady: true,
      formPresent: true,
      handleValid: true,
      passwordValid: false,
      formValid: false,
      submitEnabled: true,
    },
  });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_NATIVE_VALIDITY_SENTINEL');
  expect(attempts).toBe(0);
  expect(listeners(page)).toEqual(before);
});
