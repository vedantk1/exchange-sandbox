import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runStartupChecks,
  startupOptions,
  STARTUP_BUDGET_MS,
} from '../../scripts/deploy/startup-checks.js';
import {
  acceptanceReport,
  JOURNEY_CHECKS,
  SETUP_CHECKS,
} from '../../scripts/deploy/acceptance/report.js';
import type { SelfHostAcceptanceResult } from '../../scripts/deploy/verify-self-host.js';

type Run = NonNullable<Parameters<typeof runStartupChecks>[1]>;
const commit = 'a'.repeat(40);
const options = startupOptions([]);

function result(): SelfHostAcceptanceResult {
  return {
    report: acceptanceReport({
      stage: 'complete',
      source: { commit, dirty: false },
      images: {
        api: { id: `sha256:${'b'.repeat(64)}`, revision: commit },
        web: { id: `sha256:${'c'.repeat(64)}`, revision: commit },
        postgres: { id: `sha256:${'d'.repeat(64)}`, revision: null },
      },
      checks: Object.fromEntries([...SETUP_CHECKS, ...JOURNEY_CHECKS].map((name) => [name, true])),
      cleanup: {
        containersRemoved: true,
        volumesRemoved: true,
        networksRemoved: true,
        privateFilesRemoved: true,
      },
    }),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('bounded fresh Compose startup observations', () => {
  it('defaults to five and permits only an explicit bounded narrower probe', () => {
    expect(options.runs).toBe(5);
    expect(startupOptions(['api:probe', 'web:probe', '--runs=2'])).toEqual({
      apiImage: 'api:probe',
      webImage: 'web:probe',
      runs: 2,
    });
    for (const arguments_ of [
      ['--runs=0'],
      ['--runs=6'],
      ['--runs=01'],
      ['--runs=1.5'],
      ['--runs=2', '--runs=3'],
      ['--unknown'],
      ['api', 'web', 'extra'],
      ['image with spaces'],
    ])
      expect(() => startupOptions(arguments_)).toThrow();
  });

  it('requires five independent returned results without overwriting standalone evidence', async () => {
    const run = vi.fn<Run>(async () => result());
    const report = await runStartupChecks(options, run);
    expect(report.status).toBe('passed');
    expect(report).toMatchObject({
      requestedRuns: 5,
      attemptedRuns: 5,
      passedRuns: 5,
      firstFailure: null,
    });
    expect(run).toHaveBeenCalledTimes(5);
    for (const [argument] of run.mock.calls) {
      expect(argument).toMatchObject({
        apiImage: options.apiImage,
        webImage: options.webImage,
        writeReport: false,
      });
      expect(argument?.signal?.aborted).toBe(false);
    }
    expect(report.runs[0]?.acceptance).not.toBe(report.runs[1]?.acceptance);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at the first failure and preserves its fixed checkpoint without private extras', async () => {
    const failed = result();
    failed.report.checks.compiledUiLogin = false;
    failed.failure = {
      code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED',
      browserCleanupFailed: true,
      checkpoint: {
        documentLoaded: true,
        scriptRequests: 1,
        scriptResponses: 1,
        scriptHttpStatus: null,
        scriptFailure: null,
        session: 'IN_FLIGHT',
        sessionFailure: null,
        pageErrors: 0,
        capabilities: 'AVAILABLE',
      },
    };
    Object.assign(failed, { password: 'PRIVATE_SENTINEL' });
    Object.assign(failed.failure.checkpoint!, { url: 'https://PRIVATE_SENTINEL.invalid' });
    Object.assign(failed.report, { cause: 'PRIVATE_SENTINEL' });
    const run = vi.fn<Run>().mockResolvedValueOnce(result()).mockResolvedValueOnce(failed);
    const report = await runStartupChecks(options, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ status: 'failed', attemptedRuns: 2, passedRuns: 1 });
    expect(report.firstFailure).toMatchObject({
      attempt: 2,
      reason: 'ACCEPTANCE_FAILED',
      code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED',
      browserCleanupFailed: true,
      checkpoint: { session: 'IN_FLIGHT', documentLoaded: true },
    });
    expect(report.firstFailure).toEqual(report.runs[1]?.failure);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  });

  it('never starts another installation when cleanup is uncertain', async () => {
    const failed = result();
    failed.report.cleanup.volumesRemoved = false;
    failed.failure = { code: 'ACCEPTANCE_LOGIN_ADMIN_RENDER_FAILED' };
    const run = vi.fn<Run>().mockResolvedValue(failed);
    const report = await runStartupChecks(options, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.firstFailure).toMatchObject({
      reason: 'CLEANUP_UNCONFIRMED',
      code: failed.failure.code,
    });
    expect(report.runs[0]?.acceptance?.cleanup.volumesRemoved).toBe(false);
  });

  it('retains exact submission and runtime categories while excluding private fields', async () => {
    const failed = result();
    failed.failure = {
      code: 'ACCEPTANCE_LOGIN_ADMIN_POST_REQUEST_FAILED_HTTP2_PROTOCOL_FAILED',
      submissionCheckpoint: {
        stage: 'POST_RESPONSE',
        request: 'FAILED',
        httpStatus: null,
        requestFailure: 'HTTP2_PROTOCOL',
        inputStateAvailable: true,
        documentReady: true,
        formPresent: true,
        handleValid: true,
        passwordValid: true,
        formValid: true,
        submitEnabled: true,
      },
      runtimeCheckpoint: { available: true, running: false, oomKilled: true, restartCount: 1 },
    };
    Object.assign(failed.failure.submissionCheckpoint!, {
      password: 'PRIVATE_SENTINEL',
      validationMessage: 'PRIVATE_SENTINEL',
    });
    Object.assign(failed.failure.runtimeCheckpoint!, { containerId: 'PRIVATE_SENTINEL' });
    const run = vi.fn<Run>().mockResolvedValue(failed);
    const report = await runStartupChecks(options, run);
    expect(report.firstFailure).toMatchObject({
      code: 'ACCEPTANCE_LOGIN_ADMIN_POST_REQUEST_FAILED_HTTP2_PROTOCOL_FAILED',
      submissionCheckpoint: {
        request: 'FAILED',
        requestFailure: 'HTTP2_PROTOCOL',
        formValid: true,
      },
      runtimeCheckpoint: { available: true, running: false, oomKilled: true, restartCount: 1 },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  });

  it.each([
    'FILL_HANDLE',
    'FILL_PASSWORD',
    'CLICK',
    'POST_RESPONSE',
    'POST_NOT_REQUESTED',
    'POST_IN_FLIGHT',
    'POST_HTTP_503',
    'POST_REQUEST_FAILED_NETWORK_CHANGED',
  ])(
    'preserves fixed submission stage code %s without admitting arbitrary strings',
    async (code) => {
      const failed = result();
      failed.failure = { code: `ACCEPTANCE_LOGIN_ADMIN_${code}_FAILED` };
      const report = await runStartupChecks(options, vi.fn<Run>().mockResolvedValue(failed));
      expect(report.firstFailure?.code).toBe(failed.failure.code);
    },
  );

  it('retains a bounded network-readiness failure and stops before another installation', async () => {
    const failed = result();
    failed.failure = { code: 'ACCEPTANCE_NETWORK_READINESS_FAILED' };
    const run = vi.fn<Run>().mockResolvedValue(failed);
    const report = await runStartupChecks(options, run);
    expect(report.firstFailure?.code).toBe(failed.failure.code);
    expect(run).toHaveBeenCalledOnce();
  });

  it('does not substitute an old success when an invocation throws or cannot return its result', async () => {
    const run = vi
      .fn<Run>()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('PRIVATE_SENTINEL'));
    const report = await runStartupChecks(options, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(report.firstFailure).toMatchObject({ attempt: 2, reason: 'RESULT_UNAVAILABLE' });
    expect(report.runs[1]?.acceptance).toBeNull();
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  });

  it('rejects stale timestamps rather than re-stamping earlier acceptance evidence', async () => {
    const stale = result();
    vi.advanceTimersByTime(1);
    const run = vi.fn<Run>().mockResolvedValue(stale);
    const report = await runStartupChecks(options, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.firstFailure?.reason).toBe('STALE_RESULT');
    expect(report.runs[0]?.acceptance?.generatedAt).toBe(stale.report.generatedAt);
  });

  it('does not publish malformed timestamp or arbitrary failure strings', async () => {
    const failed = result();
    failed.report.generatedAt = 'PRIVATE_SENTINEL';
    failed.failure = { code: 'ACCEPTANCE_LOGIN_ADMIN_PRIVATE_SENTINEL_FAILED' };
    const report = await runStartupChecks(options, vi.fn<Run>().mockResolvedValue(failed));
    expect(report.firstFailure).toMatchObject({
      reason: 'STALE_RESULT',
      code: 'ACCEPTANCE_FAILED',
    });
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  });

  it.each(['api', 'web', 'postgres'] as const)(
    'requires the same %s image identity throughout',
    async (image) => {
      const changed = result();
      changed.report.images[image]!.id = `sha256:${'e'.repeat(64)}`;
      const run = vi.fn<Run>().mockResolvedValueOnce(result()).mockResolvedValueOnce(changed);
      const report = await runStartupChecks(options, run);
      expect(run).toHaveBeenCalledTimes(2);
      expect(report.firstFailure?.reason).toBe('IMAGE_IDENTITY_CHANGED');
    },
  );

  it('requires a single clean source revision, even outside CI', async () => {
    const changed = result();
    changed.report.source.commit = 'e'.repeat(40);
    changed.report.images.api!.revision = changed.report.source.commit;
    changed.report.images.web!.revision = changed.report.source.commit;
    const run = vi.fn<Run>().mockResolvedValueOnce(result()).mockResolvedValueOnce(changed);
    expect((await runStartupChecks(options, run)).firstFailure?.reason).toBe(
      'SOURCE_IDENTITY_CHANGED',
    );
    const dirty = result();
    dirty.report.source.dirty = true;
    const dirtyRun = vi.fn<Run>().mockResolvedValue(dirty);
    expect((await runStartupChecks(options, dirtyRun)).firstFailure?.reason).toBe(
      'SOURCE_IDENTITY_CHANGED',
    );
    expect(dirtyRun).toHaveBeenCalledTimes(1);
  });

  it('propagates the ten-minute deadline but waits for the current run to confirm cleanup', async () => {
    let cleanupFinished = false;
    const run = vi.fn<Run>(async (argument) => {
      await new Promise<void>((resolve) =>
        argument?.signal?.addEventListener('abort', () => resolve(), { once: true }),
      );
      cleanupFinished = true;
      return result();
    });
    const pending = runStartupChecks(options, run);
    await vi.advanceTimersByTimeAsync(STARTUP_BUDGET_MS);
    const report = await pending;
    expect(cleanupFinished).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(report.firstFailure?.reason).toBe('BATCH_DEADLINE');
    expect(Object.values(report.runs[0]!.acceptance!.cleanup).every(Boolean)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start an installation after interruption', async () => {
    const run = vi.fn<Run>();
    const report = await runStartupChecks(options, run, AbortSignal.abort());
    expect(run).not.toHaveBeenCalled();
    expect(report).toMatchObject({ status: 'failed', attemptedRuns: 0, passedRuns: 0 });
    expect(report.firstFailure?.reason).toBe('BATCH_INTERRUPTED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects invalid programmatic run counts before starting work', async () => {
    const run = vi.fn<Run>();
    for (const runs of [0, 6, 1.5, Number.NaN])
      await expect(runStartupChecks({ ...options, runs }, run)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
