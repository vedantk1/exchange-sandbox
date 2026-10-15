import { AcceptanceJourneyError } from './login.js';

/** Cleanup must fail closed without replacing the checkpoint that first failed. */
export async function closeJourneyBrowser(
  close: () => Promise<void>,
  firstFailure?: AcceptanceJourneyError,
): Promise<void> {
  try {
    await close();
  } catch {
    const failure = firstFailure ?? new AcceptanceJourneyError('ACCEPTANCE_BROWSER_CLEANUP_FAILED');
    failure.browserCleanupFailed = true;
    throw failure;
  }
}
