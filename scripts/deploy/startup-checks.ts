import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { formatLoginCheckpoint } from './acceptance/login.js';
import { formatLoginSubmissionCheckpoint } from './acceptance/submission.js';
import { formatRuntimeCheckpoint } from './acceptance/runtime-checkpoint.js';
import { acceptanceReport, type AcceptanceStage } from './acceptance/report.js';
import { runSelfHostAcceptance, type SelfHostAcceptanceResult } from './verify-self-host.js';

export const STARTUP_RUNS = 5;
export const STARTUP_BUDGET_MS = 10 * 60_000;
export const STARTUP_REPORT_PATH = '.local/operations/self-host-startup-checks-result.json';
type AcceptanceReport = ReturnType<typeof acceptanceReport>;
type Run = typeof runSelfHostAcceptance;
export interface StartupOptions {
  apiImage: string;
  webImage: string;
  runs: number;
}

export function startupOptions(arguments_: string[]): StartupOptions {
  const positional: string[] = [];
  let runs = STARTUP_RUNS;
  let countSeen = false;
  for (const argument of arguments_) {
    if (argument.startsWith('--runs=')) {
      assert.equal(countSeen, false);
      assert.match(argument, /^--runs=[1-5]$/);
      countSeen = true;
      runs = Number(argument.slice('--runs='.length));
    } else {
      assert.match(argument, /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,250}$/);
      positional.push(argument);
    }
  }
  assert.ok(positional.length <= 2);
  return {
    apiImage: positional[0] ?? 'spot-exchange-simulator-api:local',
    webImage: positional[1] ?? 'spot-exchange-simulator-web:local',
    runs,
  };
}

type FailureReason =
  | 'ACCEPTANCE_FAILED'
  | 'CLEANUP_UNCONFIRMED'
  | 'RESULT_UNAVAILABLE'
  | 'STALE_RESULT'
  | 'SOURCE_IDENTITY_CHANGED'
  | 'IMAGE_IDENTITY_CHANGED'
  | 'BATCH_INTERRUPTED'
  | 'BATCH_DEADLINE';
interface Failure {
  attempt: number | null;
  reason: FailureReason;
  code: string | null;
  checkpoint: Record<string, unknown> | null;
  submissionCheckpoint: Record<string, unknown> | null;
  runtimeCheckpoint: Record<string, unknown> | null;
  browserCleanupFailed: boolean;
}

const network =
  '(?:CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_CLOSED|CERTIFICATE|TLS_PROTOCOL|HTTP2_PROTOCOL|QUIC_PROTOCOL|ABORTED|TIMEOUT|CONTENT_DECODING|OTHER)';
const loginCode = new RegExp(
  '^ACCEPTANCE_LOGIN_(?:ADMIN|SELLER|BUYER)_(?:NAVIGATION|RENDER|SUBMISSION|SYNC|' +
    'FILL_HANDLE|FILL_PASSWORD|CLICK|POST_RESPONSE|POST_IN_FLIGHT|POST_NOT_REQUESTED|' +
    'POST_HTTP_(?:[1-5][0-9]{2}|OTHER)|POST_REQUEST_FAILED_' +
    network +
    '|' +
    '(?:DOCUMENT|SESSION)_HTTP_(?:[1-5][0-9]{2}|OTHER)|' +
    'ENTRY_SCRIPT_HTTP_[45][0-9]{2}|ENTRY_SCRIPT_REQUEST_FAILED_' +
    network +
    '|SESSION_REQUEST_FAILED_BEFORE_RESPONSE_' +
    network +
    '|RUNTIME_EXCEPTION|INSECURE_CONTEXT|ABORT_TIMEOUT_UNAVAILABLE|ABORT_ANY_UNAVAILABLE|' +
    'ENTRY_SCRIPT_NOT_REQUESTED|ENTRY_SCRIPT_IN_FLIGHT|SESSION_IN_FLIGHT|SESSION_NOT_REQUESTED)_FAILED$',
);
const fixedCodes = new Set([
  'ACCEPTANCE_FAILED',
  'ACCEPTANCE_BROWSER_FAILED',
  'ACCEPTANCE_BROWSER_CLEANUP_FAILED',
  'ACCEPTANCE_INTERRUPTED',
  'OPERATOR_INPUT_INVALID',
  'OPERATOR_CANCELED',
  'OPERATOR_TERMINAL_START_FAILED',
  'OPERATOR_TERMINAL_INPUT_FAILED',
  'OPERATOR_TERMINAL_TIMEOUT',
  'OPERATOR_CREATION_UNCONFIRMED',
]);

function failureDetails(value: SelfHostAcceptanceResult['failure']) {
  const code = value?.code;
  const checkpoint = formatLoginCheckpoint(value?.checkpoint);
  const submissionCheckpoint = formatLoginSubmissionCheckpoint(value?.submissionCheckpoint);
  const runtimeCheckpoint = formatRuntimeCheckpoint(value?.runtimeCheckpoint);
  return {
    code:
      typeof code === 'string' && (fixedCodes.has(code) || loginCode.test(code))
        ? code
        : value
          ? 'ACCEPTANCE_FAILED'
          : null,
    checkpoint: checkpoint ? (JSON.parse(checkpoint) as Record<string, unknown>) : null,
    submissionCheckpoint: submissionCheckpoint
      ? (JSON.parse(submissionCheckpoint) as Record<string, unknown>)
      : null,
    runtimeCheckpoint: runtimeCheckpoint
      ? (JSON.parse(runtimeCheckpoint) as Record<string, unknown>)
      : null,
    browserCleanupFailed: value?.browserCleanupFailed === true,
  };
}

/** Reconstruct the existing report allowlist; never retain extra runner fields or raw causes. */
function currentReport(value: AcceptanceReport): AcceptanceReport {
  const report = acceptanceReport({
    stage: value.stage as AcceptanceStage,
    source: { commit: value.source.commit ?? '', dirty: value.source.dirty !== false },
    images: value.images,
    checks: value.checks,
    cleanup: {
      containersRemoved: value.cleanup.containersRemoved === true,
      volumesRemoved: value.cleanup.volumesRemoved === true,
      networksRemoved: value.cleanup.networksRemoved === true,
      privateFilesRemoved: value.cleanup.privateFilesRemoved === true,
    },
  });
  // Keep the invocation's timestamp so an old successful result cannot become a new attempt.
  const generatedAt = Date.parse(value.generatedAt);
  report.generatedAt = Number.isFinite(generatedAt)
    ? new Date(generatedAt).toISOString()
    : new Date(0).toISOString();
  return report;
}

/** Five independent installations by default. Failure ends observation; it is never retried. */
export async function runStartupChecks(
  options: StartupOptions,
  run: Run = runSelfHostAcceptance,
  externalSignal?: AbortSignal,
) {
  assert.ok(Number.isInteger(options.runs) && options.runs >= 1 && options.runs <= STARTUP_RUNS);
  // Apply the same image validation to programmatic callers as to the CLI.
  startupOptions([options.apiImage, options.webImage]);
  const controller = new AbortController();
  const signal = externalSignal
    ? AbortSignal.any([controller.signal, externalSignal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), STARTUP_BUDGET_MS);
  const runs: {
    attempt: number;
    acceptance: AcceptanceReport | null;
    failure: Failure | null;
  }[] = [];
  let firstFailure: Failure | null = null;
  let baseline: AcceptanceReport | undefined;
  const interrupted = (): FailureReason =>
    controller.signal.aborted ? 'BATCH_DEADLINE' : 'BATCH_INTERRUPTED';
  try {
    for (let attempt = 1; attempt <= options.runs; attempt++) {
      if (signal.aborted) {
        firstFailure = {
          attempt: null,
          reason: interrupted(),
          code: null,
          checkpoint: null,
          submissionCheckpoint: null,
          runtimeCheckpoint: null,
          browserCleanupFailed: false,
        };
        break;
      }
      const startedAt = Date.now();
      let report: AcceptanceReport | null = null;
      let failure: Failure | null = null;
      try {
        const result = await run({
          apiImage: options.apiImage,
          webImage: options.webImage,
          signal,
          writeReport: false,
        });
        report = currentReport(result.report);
        const generatedAt = Date.parse(report.generatedAt);
        let reason: FailureReason | undefined;
        if (!Object.values(report.cleanup).every(Boolean)) reason = 'CLEANUP_UNCONFIRMED';
        else if (
          !Number.isFinite(generatedAt) ||
          generatedAt < startedAt ||
          generatedAt > Date.now()
        )
          reason = 'STALE_RESULT';
        else if (
          report.source.dirty ||
          !report.source.commit ||
          (baseline && report.source.commit !== baseline.source.commit)
        )
          reason = 'SOURCE_IDENTITY_CHANGED';
        else if (baseline && JSON.stringify(report.images) !== JSON.stringify(baseline.images))
          reason = 'IMAGE_IDENTITY_CHANGED';
        else if (signal.aborted) reason = interrupted();
        else if (report.status !== 'passed' || result.failure) reason = 'ACCEPTANCE_FAILED';
        if (reason) failure = { attempt, reason, ...failureDetails(result.failure) };
        else baseline ??= report;
      } catch {
        failure = {
          attempt,
          reason: signal.aborted ? interrupted() : 'RESULT_UNAVAILABLE',
          code: null,
          checkpoint: null,
          submissionCheckpoint: null,
          runtimeCheckpoint: null,
          browserCleanupFailed: false,
        };
      }
      runs.push({ attempt, acceptance: report, failure });
      if (failure) {
        firstFailure = failure;
        break;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const passedRuns = runs.filter((run) => !run.failure).length;
  return {
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    kind: 'fresh-compose-https-startup-checks',
    status: !firstFailure && passedRuns === options.runs ? 'passed' : 'failed',
    requestedRuns: options.runs,
    attemptedRuns: runs.length,
    passedRuns,
    overallBudgetMilliseconds: STARTUP_BUDGET_MS,
    firstFailure,
    runs,
    scope:
      'Independent fresh Compose installations using the same clean source and image identities. Existing acceptance, HTTPS verification, login budgets and scoped cleanup are unchanged. Failed attempts are not retried. Repetition is not a capacity benchmark or proof that an intermittent failure is fixed.',
  };
}

if (import.meta.main) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    for (const directory of ['.local', '.local/operations']) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      assert.ok(info.isDirectory() && !info.isSymbolicLink());
    }
    // No prior success may survive a new invocation that fails before report creation.
    await rm(STARTUP_REPORT_PATH, { force: true });
    const report = await runStartupChecks(
      startupOptions(process.argv.slice(2)),
      undefined,
      controller.signal,
    );
    const temporary = `${STARTUP_REPORT_PATH}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, STARTUP_REPORT_PATH);
    console.log(
      `Self-host startup checks ${report.status}; ${report.passedRuns}/${report.requestedRuns} passed. Sanitized report: ${STARTUP_REPORT_PATH}.`,
    );
    process.exitCode = report.status === 'passed' ? 0 : 1;
  } catch {
    console.error(
      'Self-host startup checks could not finish safely. Inspect the scoped cleanup status.',
    );
    process.exitCode = 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
