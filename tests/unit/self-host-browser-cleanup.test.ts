import { expect, it, vi } from 'vitest';
import { closeJourneyBrowser } from '../../scripts/deploy/acceptance/browser-cleanup.js';
import { AcceptanceJourneyError } from '../../scripts/deploy/acceptance/login.js';

it('preserves the original login code and checkpoint when browser cleanup also fails', async () => {
  const first = new AcceptanceJourneyError('ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED', {
    documentLoaded: true,
    scriptRequests: 1,
    scriptResponses: 1,
    scriptHttpStatus: null,
    scriptFailure: null,
    session: 'IN_FLIGHT',
    sessionFailure: null,
    pageErrors: 0,
    capabilities: 'AVAILABLE',
  });
  const checkpoint = first.checkpoint;
  const close = vi.fn().mockRejectedValue(new Error('PRIVATE_CLEANUP_SENTINEL'));
  await expect(closeJourneyBrowser(close, first)).rejects.toBe(first);
  expect(first.code).toBe('ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED');
  expect(first.checkpoint).toBe(checkpoint);
  expect(first.browserCleanupFailed).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(first)).not.toContain('PRIVATE_CLEANUP_SENTINEL');
});

it('fails an otherwise successful journey when browser cleanup is not confirmed', async () => {
  const close = vi.fn().mockRejectedValue(new Error('PRIVATE_CLEANUP_SENTINEL'));
  const failure = await closeJourneyBrowser(close).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AcceptanceJourneyError);
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_BROWSER_CLEANUP_FAILED',
    browserCleanupFailed: true,
  });
  expect(JSON.stringify(failure)).not.toContain('PRIVATE_CLEANUP_SENTINEL');
  await expect(closeJourneyBrowser(async () => undefined)).resolves.toBeUndefined();
});
