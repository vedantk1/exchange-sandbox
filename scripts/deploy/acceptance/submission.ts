import type { Page, Request, Response } from '@playwright/test';
import {
  AcceptanceJourneyError,
  networkFailure,
  NETWORK_FAILURES,
  type NetworkFailure,
} from './login.js';

const PHASES = ['FILL_HANDLE', 'FILL_PASSWORD', 'CLICK', 'POST_RESPONSE', 'UNKNOWN'] as const;
const REQUESTS = ['NOT_REQUESTED', 'IN_FLIGHT', 'FAILED', 'RESPONDED'] as const;
type Phase = (typeof PHASES)[number];
interface InputState {
  inputStateAvailable: boolean;
  documentReady: boolean;
  formPresent: boolean;
  handleValid: boolean;
  passwordValid: boolean;
  formValid: boolean;
  submitEnabled: boolean;
}
export interface LoginSubmissionCheckpoint extends InputState {
  stage: Phase;
  request: (typeof REQUESTS)[number];
  httpStatus: number | null;
  requestFailure: NetworkFailure | null;
}

const emptyInput = (): InputState => ({
  inputStateAvailable: false,
  documentReady: false,
  formPresent: false,
  handleValid: false,
  passwordValid: false,
  formValid: false,
  submitEnabled: false,
});

/** Reconstruct primitives only: no DOM text, input values, URLs, bodies or browser messages. */
export function formatLoginSubmissionCheckpoint(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return;
  try {
    const {
      stage,
      request,
      httpStatus,
      requestFailure,
      inputStateAvailable,
      documentReady,
      formPresent,
      handleValid,
      passwordValid,
      formValid,
      submitEnabled,
    } = value as Record<string, unknown>;
    const checkpoint: LoginSubmissionCheckpoint = {
      stage: PHASES.some((item) => item === stage) ? (stage as Phase) : 'UNKNOWN',
      request: REQUESTS.some((item) => item === request)
        ? (request as LoginSubmissionCheckpoint['request'])
        : 'NOT_REQUESTED',
      httpStatus:
        typeof httpStatus === 'number' &&
        Number.isInteger(httpStatus) &&
        httpStatus >= 100 &&
        httpStatus <= 599
          ? httpStatus
          : null,
      requestFailure: NETWORK_FAILURES.some((item) => item === requestFailure)
        ? (requestFailure as NetworkFailure)
        : null,
      inputStateAvailable: inputStateAvailable === true,
      documentReady: documentReady === true,
      formPresent: formPresent === true,
      handleValid: handleValid === true,
      passwordValid: passwordValid === true,
      formValid: formValid === true,
      submitEnabled: submitEnabled === true,
    };
    return JSON.stringify(checkpoint);
  } catch {
    return;
  }
}

async function inputState(page: Page): Promise<InputState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page
        .evaluate<InputState>(() => {
          const form = document.querySelector('form');
          const handle = form?.querySelector<HTMLInputElement>('input[name="username"]');
          const password = form?.querySelector<HTMLInputElement>('input[name="password"]');
          const submit = form?.querySelector<HTMLButtonElement>('button');
          return {
            inputStateAvailable: true,
            documentReady: document.readyState !== 'loading',
            formPresent: Boolean(form),
            handleValid: handle?.validity.valid === true,
            passwordValid: password?.validity.valid === true,
            formValid: form?.matches(':valid') === true,
            submitEnabled: Boolean(submit && !submit.disabled),
          };
        })
        .catch(emptyInput),
      new Promise<InputState>((resolve) => {
        timer = setTimeout(() => resolve(emptyInput()), 500);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observeSubmission(page: Page, origin: string, stage: () => Phase) {
  const checkpoint: LoginSubmissionCheckpoint = {
    ...emptyInput(),
    stage: 'CLICK',
    request: 'NOT_REQUESTED',
    httpStatus: null,
    requestFailure: null,
  };
  let settled: Readonly<LoginSubmissionCheckpoint> | undefined;
  let complete!: (response: Response | undefined) => void;
  const response = new Promise<Response | undefined>((resolve) => {
    complete = resolve;
  });
  const settle = (value: Response | undefined) => {
    if (settled) return;
    settled = Object.freeze({ ...checkpoint, stage: stage() });
    complete(value);
  };
  const matches = (request: Request) =>
    request.url() === `${origin}/api/auth/login` && request.method() === 'POST';
  const requested = (request: Request) => {
    if (matches(request)) checkpoint.request = 'IN_FLIGHT';
  };
  const responded = (response: Response) => {
    if (!matches(response.request())) return;
    checkpoint.request = 'RESPONDED';
    checkpoint.httpStatus = response.status();
    settle(response);
  };
  const failed = (request: Request) => {
    if (!matches(request)) return;
    checkpoint.request = 'FAILED';
    checkpoint.requestFailure = networkFailure(request);
    settle(undefined);
  };
  const timer = setTimeout(() => settle(undefined), 12_000);
  page.on('request', requested);
  page.on('response', responded);
  page.on('requestfailed', failed);
  return {
    response,
    freeze() {
      settle(undefined);
      return { ...settled! };
    },
    close() {
      clearTimeout(timer);
      settle(undefined);
      page.off('request', requested);
      page.off('response', responded);
      page.off('requestfailed', failed);
    },
  };
}

/** Original action/POST budgets remain 12 seconds; a failed submission is never retried. */
export async function submitLogin(
  page: Page,
  origin: string,
  role: 'ADMIN' | 'SELLER' | 'BUYER',
  handle: string,
  password: string,
): Promise<void> {
  const prefix = `ACCEPTANCE_LOGIN_${role}`;
  let phase: Phase = 'FILL_HANDLE';
  let observer: ReturnType<typeof observeSubmission> | undefined;
  const failure = async (code: string): Promise<never> => {
    const checkpoint = observer?.freeze() ?? {
      ...emptyInput(),
      stage: phase,
      request: 'NOT_REQUESTED' as const,
      httpStatus: null,
      requestFailure: null,
    };
    observer?.close();
    Object.assign(checkpoint, await inputState(page));
    const sanitized = JSON.parse(formatLoginSubmissionCheckpoint(checkpoint)!);
    throw new AcceptanceJourneyError(`${prefix}_${code}_FAILED`, undefined, sanitized);
  };
  try {
    await page.getByLabel(/^Handle/).fill(handle, { timeout: 12_000 });
    phase = 'FILL_PASSWORD';
    await page.getByLabel('Password', { exact: true }).fill(password, { timeout: 12_000 });
    phase = 'CLICK';
    observer = observeSubmission(page, origin, () => phase);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: 12_000 });
    phase = 'POST_RESPONSE';
    const response = await observer.response;
    if (!response) {
      const checkpoint = observer.freeze();
      const reason =
        checkpoint.request === 'FAILED'
          ? `POST_REQUEST_FAILED_${checkpoint.requestFailure ?? 'OTHER'}`
          : checkpoint.request === 'IN_FLIGHT'
            ? 'POST_IN_FLIGHT'
            : 'POST_NOT_REQUESTED';
      await failure(reason);
    }
    const status = response!.status();
    if (status !== 200)
      await failure(`POST_HTTP_${status >= 100 && status <= 599 ? status : 'OTHER'}`);
  } catch (error) {
    if (error instanceof AcceptanceJourneyError) throw error;
    await failure(phase);
  } finally {
    observer?.close();
  }
}
