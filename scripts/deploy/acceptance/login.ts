import { expect, type Page, type Request, type Response } from '@playwright/test';
import type { LoginSubmissionCheckpoint } from './submission.js';

export const NETWORK_FAILURES = [
  'CONNECTION_RESET',
  'CONNECTION_REFUSED',
  'CONNECTION_CLOSED',
  'CERTIFICATE',
  'TLS_PROTOCOL',
  'HTTP2_PROTOCOL',
  'QUIC_PROTOCOL',
  'ABORTED',
  'TIMEOUT',
  'CONTENT_DECODING',
  'OTHER',
] as const;
export type NetworkFailure = (typeof NETWORK_FAILURES)[number];
const CAPABILITIES = [
  'AVAILABLE',
  'INSECURE_CONTEXT',
  'ABORT_TIMEOUT_UNAVAILABLE',
  'ABORT_ANY_UNAVAILABLE',
  'UNAVAILABLE',
] as const;
type Capability = (typeof CAPABILITIES)[number];
const SESSIONS = ['NOT_REQUESTED', 'IN_FLIGHT', 'FAILED', 'RESPONDED'] as const;

export interface LoginBootstrapCheckpoint {
  documentLoaded: boolean;
  scriptRequests: number;
  scriptResponses: number;
  scriptHttpStatus: number | null;
  scriptFailure: NetworkFailure | null;
  session: 'NOT_REQUESTED' | 'IN_FLIGHT' | 'FAILED' | 'RESPONDED';
  sessionFailure: NetworkFailure | null;
  pageErrors: number;
  capabilities: Capability;
}

/** No raw causes, URLs, browser messages, DOM or response bodies enter acceptance errors. */
export class AcceptanceJourneyError extends Error {
  browserCleanupFailed = false;

  constructor(
    readonly code: string,
    readonly checkpoint?: LoginBootstrapCheckpoint,
    readonly submissionCheckpoint?: LoginSubmissionCheckpoint,
  ) {
    super(code);
  }
}

/** Reconstruct fixed checkpoint fields before writing a failure to CI output. */
export function formatLoginCheckpoint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  try {
    const {
      documentLoaded,
      scriptRequests,
      scriptResponses,
      scriptHttpStatus,
      scriptFailure,
      session,
      sessionFailure,
      pageErrors,
      capabilities,
    } = value as Record<string, unknown>;
    const count = (candidate: unknown) =>
      typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate >= 0
        ? Math.min(candidate, 255)
        : 0;
    const network = (candidate: unknown): NetworkFailure | null =>
      NETWORK_FAILURES.some((item) => item === candidate) ? (candidate as NetworkFailure) : null;
    const checkpoint: LoginBootstrapCheckpoint = {
      documentLoaded: documentLoaded === true,
      scriptRequests: count(scriptRequests),
      scriptResponses: count(scriptResponses),
      scriptHttpStatus:
        typeof scriptHttpStatus === 'number' &&
        Number.isInteger(scriptHttpStatus) &&
        scriptHttpStatus >= 400 &&
        scriptHttpStatus <= 599
          ? scriptHttpStatus
          : null,
      scriptFailure: network(scriptFailure),
      session: SESSIONS.some((item) => item === session)
        ? (session as LoginBootstrapCheckpoint['session'])
        : 'NOT_REQUESTED',
      sessionFailure: network(sessionFailure),
      pageErrors: count(pageErrors),
      capabilities: CAPABILITIES.some((item) => item === capabilities)
        ? (capabilities as Capability)
        : 'UNAVAILABLE',
    };
    return JSON.stringify(checkpoint);
  } catch {
    return;
  }
}

export function networkFailure(request: Request): NetworkFailure {
  const text = request.failure()?.errorText ?? '';
  if (text.startsWith('net::ERR_CERT_')) return 'CERTIFICATE';
  switch (text) {
    case 'net::ERR_CONNECTION_RESET':
      return 'CONNECTION_RESET';
    case 'net::ERR_CONNECTION_REFUSED':
      return 'CONNECTION_REFUSED';
    case 'net::ERR_CONNECTION_CLOSED':
      return 'CONNECTION_CLOSED';
    case 'net::ERR_SSL_PROTOCOL_ERROR':
      return 'TLS_PROTOCOL';
    case 'net::ERR_HTTP2_PROTOCOL_ERROR':
      return 'HTTP2_PROTOCOL';
    case 'net::ERR_QUIC_PROTOCOL_ERROR':
      return 'QUIC_PROTOCOL';
    case 'net::ERR_ABORTED':
      return 'ABORTED';
    case 'net::ERR_TIMED_OUT':
      return 'TIMEOUT';
    case 'net::ERR_CONTENT_DECODING_FAILED':
      return 'CONTENT_DECODING';
    default:
      return 'OTHER';
  }
}

function observe(page: Page, origin: string) {
  const checkpoint: LoginBootstrapCheckpoint = {
    documentLoaded: false,
    scriptRequests: 0,
    scriptResponses: 0,
    scriptHttpStatus: null,
    scriptFailure: null,
    session: 'NOT_REQUESTED',
    sessionFailure: null,
    pageErrors: 0,
    capabilities: 'UNAVAILABLE',
  };
  let resolve!: (response: Response | undefined) => void;
  let settled: Readonly<LoginBootstrapCheckpoint> | undefined;
  const session = new Promise<Response | undefined>((complete) => {
    resolve = complete;
  });
  const settle = (response: Response | undefined) => {
    if (settled) return;
    // Late responses or errors must not rewrite the condition that ended this
    // observation window, including while navigation or capability probing waits.
    settled = Object.freeze({ ...checkpoint });
    resolve(response);
  };
  const timer = setTimeout(() => settle(undefined), 12_000);
  const isSession = (request: Request) =>
    request.url() === `${origin}/api/auth/session` && request.method() === 'GET';
  const isScript = (request: Request) => {
    try {
      return request.resourceType() === 'script' && new URL(request.url()).origin === origin;
    } catch {
      return false;
    }
  };
  const requested = (request: Request) => {
    if (isSession(request)) checkpoint.session = 'IN_FLIGHT';
    if (isScript(request)) checkpoint.scriptRequests = Math.min(255, checkpoint.scriptRequests + 1);
  };
  const responded = (response: Response) => {
    if (isSession(response.request())) {
      checkpoint.session = 'RESPONDED';
      settle(response);
    }
    if (isScript(response.request())) {
      checkpoint.scriptResponses = Math.min(255, checkpoint.scriptResponses + 1);
      if (response.status() >= 400 && response.status() <= 599) {
        checkpoint.scriptHttpStatus = response.status();
        settle(undefined);
      }
    }
  };
  const failed = (request: Request) => {
    if (isSession(request)) {
      checkpoint.session = 'FAILED';
      checkpoint.sessionFailure = networkFailure(request);
      settle(undefined);
    }
    if (isScript(request)) {
      checkpoint.scriptFailure = networkFailure(request);
      settle(undefined);
    }
  };
  const runtimeError = () => {
    checkpoint.pageErrors = Math.min(255, checkpoint.pageErrors + 1);
    settle(undefined);
  };
  page.on('request', requested);
  page.on('response', responded);
  page.on('requestfailed', failed);
  page.on('pageerror', runtimeError);
  return {
    session,
    loaded() {
      checkpoint.documentLoaded = true;
    },
    snapshot() {
      return { ...(settled ?? checkpoint), documentLoaded: checkpoint.documentLoaded };
    },
    close() {
      clearTimeout(timer);
      settle(undefined);
      page.off('request', requested);
      page.off('response', responded);
      page.off('requestfailed', failed);
      page.off('pageerror', runtimeError);
    },
  };
}

async function capabilities(page: Page): Promise<Capability> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page
        .evaluate<Capability>(() => {
          if (!window.isSecureContext) return 'INSECURE_CONTEXT';
          if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function')
            return 'ABORT_TIMEOUT_UNAVAILABLE';
          if (typeof AbortSignal.any !== 'function') return 'ABORT_ANY_UNAVAILABLE';
          return 'AVAILABLE';
        })
        .catch((): Capability => 'UNAVAILABLE'),
      new Promise<Capability>((resolve) => {
        timer = setTimeout(() => resolve('UNAVAILABLE'), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function reason(checkpoint: LoginBootstrapCheckpoint): string {
  if (checkpoint.session === 'FAILED')
    return `SESSION_REQUEST_FAILED_BEFORE_RESPONSE_${checkpoint.sessionFailure ?? 'OTHER'}`;
  if (checkpoint.scriptHttpStatus !== null)
    return `ENTRY_SCRIPT_HTTP_${checkpoint.scriptHttpStatus}`;
  if (checkpoint.scriptFailure !== null)
    return `ENTRY_SCRIPT_REQUEST_FAILED_${checkpoint.scriptFailure}`;
  if (checkpoint.pageErrors) return 'RUNTIME_EXCEPTION';
  if (checkpoint.session === 'IN_FLIGHT') return 'SESSION_IN_FLIGHT';
  if (checkpoint.capabilities !== 'AVAILABLE' && checkpoint.capabilities !== 'UNAVAILABLE')
    return checkpoint.capabilities;
  if (!checkpoint.scriptRequests) return 'ENTRY_SCRIPT_NOT_REQUESTED';
  if (checkpoint.scriptRequests > checkpoint.scriptResponses) return 'ENTRY_SCRIPT_IN_FLIGHT';
  return 'SESSION_NOT_REQUESTED';
}

/** Observe before navigation. Budgets remain bounded at 12 seconds; failed requests are never retried. */
export async function openLoginPage(
  page: Page,
  origin: string,
  role: 'ADMIN' | 'SELLER' | 'BUYER',
): Promise<void> {
  const prefix = `ACCEPTANCE_LOGIN_${role}`;
  const observer = observe(page, origin);
  try {
    let document: Response | null;
    try {
      document = await page.goto(`${origin}/login`, { timeout: 12_000 });
    } catch {
      throw new AcceptanceJourneyError(`${prefix}_NAVIGATION_FAILED`);
    }
    const status = document?.status() ?? 0;
    if (status !== 200)
      throw new AcceptanceJourneyError(
        `${prefix}_DOCUMENT_HTTP_${status >= 100 && status <= 599 ? status : 'OTHER'}_FAILED`,
      );
    observer.loaded();
    const response = await observer.session;
    if (!response) {
      const checkpoint = observer.snapshot();
      checkpoint.capabilities = await capabilities(page);
      throw new AcceptanceJourneyError(`${prefix}_${reason(checkpoint)}_FAILED`, checkpoint);
    }
    const sessionStatus = response.status();
    if (sessionStatus !== 401)
      throw new AcceptanceJourneyError(
        `${prefix}_SESSION_HTTP_${sessionStatus >= 100 && sessionStatus <= 599 ? sessionStatus : 'OTHER'}_FAILED`,
      );
    try {
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible({
        timeout: 12_000,
      });
    } catch {
      throw new AcceptanceJourneyError(`${prefix}_RENDER_FAILED`);
    }
  } finally {
    observer.close();
  }
}
