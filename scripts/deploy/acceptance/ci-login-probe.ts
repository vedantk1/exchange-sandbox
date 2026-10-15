import { chromium, expect } from '@playwright/test';
import { AcceptanceJourneyError, openLoginPage } from './login.js';
import { closeJourneyBrowser } from './browser-cleanup.js';
import { submitLogin } from './submission.js';

const identifier = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(value) ? value : null;
const netError = (value: unknown): string | null =>
  typeof value === 'string' && /^net::ERR_[A-Z0-9_]{1,80}$/.test(value) ? value : null;

/** Temporary diagnostic: match the journey's three-context admin login, without trading. */
export async function runJourney(options: {
  origin: string;
  ca: string;
  certificatePin: string;
  password: string;
  restartApi: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<Record<string, boolean>> {
  for (let attempt = 1; attempt <= 1; attempt++) {
    if (options.signal?.aborted) throw new AcceptanceJourneyError('ACCEPTANCE_INTERRUPTED');
    const browser = await chromium
      .launch({
        headless: true,
        timeout: 15_000,
        args: [`--ignore-certificate-errors-spki-list=${options.certificatePin}`],
      })
      .catch(() => {
        throw new AcceptanceJourneyError('ACCEPTANCE_BROWSER_FAILED');
      });
    const abort = () => {
      void browser.close().catch(() => undefined);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    let failure: AcceptanceJourneyError | undefined;
    try {
      if (options.signal?.aborted) throw new AcceptanceJourneyError('ACCEPTANCE_INTERRUPTED');
      const contexts = await Promise.all([
        browser.newContext({ acceptDownloads: true }),
        browser.newContext({ acceptDownloads: true }),
        browser.newContext({ acceptDownloads: true }),
      ]);
      const pages = await Promise.all(contexts.map((context) => context.newPage()));
      const context = contexts[0]!;
      const page = pages[0]!;
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(12_000);
      const cdp = await context.newCDPSession(page);
      const posts = new Set<string>();
      cdp.on('Network.requestWillBeSent', (event) => {
        if (
          event.request.url === `${options.origin}/api/auth/login` &&
          event.request.method === 'POST'
        )
          posts.add(event.requestId);
      });
      cdp.on('Network.loadingFailed', (event) => {
        console.log(
          JSON.stringify({
            attempt,
            stage: posts.has(event.requestId) ? 'login_post_network' : 'other_resource_network',
            error: netError(event.errorText),
            blockedReason: identifier(event.blockedReason),
            corsError: identifier(event.corsErrorStatus?.corsError),
          }),
        );
      });
      page.on('requestfailed', (request) => {
        if (request.url() === `${options.origin}/api/auth/login` && request.method() === 'POST')
          console.log(
            JSON.stringify({
              attempt,
              stage: 'login_post_failed',
              error: netError(request.failure()?.errorText),
            }),
          );
      });
      await cdp.send('Network.enable');
      await openLoginPage(page, options.origin, 'ADMIN');
      await submitLogin(page, options.origin, 'ADMIN', 'acceptance_admin', options.password);
      await expect(page.getByText('Live · synced', { exact: true })).toBeVisible({
        timeout: 12_000,
      });
      console.log(JSON.stringify({ attempt, stage: 'login_passed' }));
    } catch (error) {
      failure =
        error instanceof AcceptanceJourneyError
          ? error
          : new AcceptanceJourneyError('ACCEPTANCE_LOGIN_FAILED');
      throw failure;
    } finally {
      options.signal?.removeEventListener('abort', abort);
      await closeJourneyBrowser(() => browser.close(), failure);
    }
  }
  return { compiledUiLogin: true };
}
