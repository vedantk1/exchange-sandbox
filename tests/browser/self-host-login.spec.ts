import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from '@playwright/test';
import { AcceptanceJourneyError, openLoginPage } from '../../scripts/deploy/acceptance/login.js';
import { test, expect } from './fixtures.js';

function listeners(page: Page) {
  // The pinned Playwright Page emitter exposes this diagnostic method at runtime.
  const emitter = page as unknown as { listenerCount(event: string): number };
  return ['request', 'response', 'requestfailed', 'pageerror'].map((event) =>
    emitter.listenerCount(event),
  );
}

test('self-host login waits for anonymous session bootstrap beyond the standalone assertion default', async ({
  page,
  application,
}) => {
  const before = listeners(page);
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
  expect(listeners(page)).toEqual(before);
});

test('self-host login reports an unexpected session status without exposing response details or retrying', async ({
  page,
  application,
}) => {
  const secret = 'PRIVATE_LOGIN_BOOTSTRAP_SENTINEL';
  const before = listeners(page);
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
  expect(listeners(page)).toEqual(before);
});

test('self-host login rejects a bad entry document without waiting for session bootstrap', async ({
  page,
  application,
}) => {
  const before = listeners(page);
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
  expect(listeners(page)).toEqual(before);
});

test('self-host bootstrap identifies an entry script transport failure without retaining browser error text', async ({
  page,
  application,
}) => {
  const before = listeners(page);
  let attempts = 0;
  await page.route('**/src/main.tsx', async (route) => {
    attempts++;
    await route.abort('connectionreset');
  });
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(AcceptanceJourneyError);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_ENTRY_SCRIPT_REQUEST_FAILED_CONNECTION_RESET_FAILED',
    checkpoint: {
      documentLoaded: true,
      scriptFailure: 'CONNECTION_RESET',
      session: 'NOT_REQUESTED',
    },
  });
  expect(JSON.stringify(failure)).not.toContain(application.origin);
  expect((failure as Error).cause).toBeUndefined();
  expect(attempts).toBe(1);
  expect(listeners(page)).toEqual(before);
});

test('self-host bootstrap identifies a main script HTTP failure without retrying', async ({
  page,
  application,
}) => {
  const before = listeners(page);
  await page.route('**/src/main.tsx', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/javascript',
      body: '/* unavailable */',
    }),
  );
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_ENTRY_SCRIPT_HTTP_503_FAILED',
    checkpoint: { documentLoaded: true, scriptHttpStatus: 503, session: 'NOT_REQUESTED' },
  });
  expect(listeners(page)).toEqual(before);
});

test('self-host bootstrap identifies runtime exceptions without exposing their messages', async ({
  page,
  application,
}) => {
  const before = listeners(page);
  const sentinel = 'PRIVATE_RUNTIME_BOOTSTRAP_SENTINEL';
  await page.route('**/src/main.tsx', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: `throw new Error('${sentinel}')`,
    }),
  );
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_RUNTIME_EXCEPTION_FAILED',
    checkpoint: {
      documentLoaded: true,
      pageErrors: 1,
      session: 'NOT_REQUESTED',
      capabilities: 'AVAILABLE',
    },
  });
  expect(JSON.stringify(failure)).not.toContain(sentinel);
  expect((failure as Error).cause).toBeUndefined();
  expect(listeners(page)).toEqual(before);
});

test('self-host bootstrap distinguishes a failed session request from one never issued', async ({
  page,
  application,
}) => {
  const before = listeners(page);
  let checks = 0;
  await page.route(`${application.origin}/api/auth/session`, async (route) => {
    checks++;
    await route.abort('connectionrefused');
  });
  const failure = await openLoginPage(page, application.origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_REQUEST_FAILED_BEFORE_RESPONSE_CONNECTION_REFUSED_FAILED',
    checkpoint: { documentLoaded: true, session: 'FAILED', sessionFailure: 'CONNECTION_REFUSED' },
  });
  expect(checks).toBe(1);
  expect(listeners(page)).toEqual(before);
});
