import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { afterEach, expect, it, vi } from 'vitest';
import {
  formatLoginSubmissionCheckpoint,
  submitLogin,
} from '../../scripts/deploy/acceptance/submission.js';

const origin = 'https://localhost:9443';
const readyInput = {
  inputStateAvailable: true,
  documentReady: true,
  formPresent: true,
  handleValid: true,
  passwordValid: true,
  formValid: true,
  submitEnabled: true,
};
const request = {
  url: () => `${origin}/api/auth/login`,
  method: () => 'POST',
  failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
};

function fakePage() {
  const page = new EventEmitter();
  const handle = vi.fn(async () => undefined);
  const password = vi.fn(async () => undefined);
  const click = vi.fn(async () => undefined);
  return Object.assign(page, {
    handle,
    password,
    click,
    getByLabel: vi.fn((label: string | RegExp) => ({
      fill: typeof label === 'string' ? password : handle,
    })),
    getByRole: vi.fn(() => ({ click })),
    evaluate: vi.fn(async () => ({ ...readyInput })),
  });
}

function closed(page: EventEmitter) {
  for (const event of ['request', 'response', 'requestfailed'])
    expect(page.listenerCount(event)).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(() => vi.useRealTimers());

it('allowlists submission primitives without values, DOM text, private extras or unknown categories', () => {
  const sentinel = 'PRIVATE_SUBMISSION_SENTINEL';
  const output = formatLoginSubmissionCheckpoint({
    ...readyInput,
    stage: 'CLICK',
    request: 'FAILED',
    httpStatus: 503,
    requestFailure: 'HTTP2_PROTOCOL',
    password: sentinel,
    handle: sentinel,
    validationMessage: sentinel,
    url: sentinel,
    cause: new Error(sentinel),
  });
  expect(JSON.parse(output!)).toEqual({
    ...readyInput,
    stage: 'CLICK',
    request: 'FAILED',
    httpStatus: 503,
    requestFailure: 'HTTP2_PROTOCOL',
  });
  expect(output).not.toContain(sentinel);
  const invalid = formatLoginSubmissionCheckpoint({
    stage: sentinel,
    request: sentinel,
    requestFailure: sentinel,
    httpStatus: 999,
    inputStateAvailable: 'true',
    handleValid: sentinel,
  });
  expect(JSON.parse(invalid!)).toMatchObject({
    stage: 'UNKNOWN',
    request: 'NOT_REQUESTED',
    requestFailure: null,
    httpStatus: null,
    inputStateAvailable: false,
    handleValid: false,
  });
  expect(invalid).not.toContain(sentinel);
});

it('reads getters once and omits getter failures without echoing private errors', () => {
  let count = 0;
  const output = formatLoginSubmissionCheckpoint(
    Object.defineProperty({}, 'request', {
      get() {
        return ++count === 1 ? 'FAILED' : 'PRIVATE_SUBMISSION_SENTINEL';
      },
    }),
  );
  expect(count).toBe(1);
  expect(JSON.parse(output!).request).toBe('FAILED');
  expect(
    formatLoginSubmissionCheckpoint(
      Object.defineProperty({}, 'stage', {
        get() {
          throw new Error('PRIVATE_SUBMISSION_SENTINEL');
        },
      }),
    ),
  ).toBeUndefined();
});

it.each(['FILL_HANDLE', 'FILL_PASSWORD', 'CLICK'] as const)(
  'identifies a failed %s action, disposes observers, and omits the raw action error',
  async (phase) => {
    vi.useFakeTimers();
    const page = fakePage();
    const action = { FILL_HANDLE: page.handle, FILL_PASSWORD: page.password, CLICK: page.click }[
      phase
    ];
    action.mockRejectedValueOnce(new Error('PRIVATE_SUBMISSION_SENTINEL'));
    const failure = await submitLogin(
      page as unknown as Page,
      origin,
      'ADMIN',
      'operator',
      'PRIVATE_SUBMISSION_SENTINEL',
    ).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: `ACCEPTANCE_LOGIN_ADMIN_${phase}_FAILED`,
      submissionCheckpoint: { stage: phase, request: 'NOT_REQUESTED', ...readyInput },
    });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_SUBMISSION_SENTINEL');
    expect((failure as Error).cause).toBeUndefined();
    closed(page);
  },
);

it('freezes an in-flight timeout before a late response arrives during the input probe', async () => {
  vi.useFakeTimers();
  const page = fakePage();
  page.click.mockImplementationOnce(async () => {
    page.emit('request', request);
  });
  let complete!: (state: typeof readyInput) => void;
  page.evaluate.mockImplementationOnce(
    () => new Promise<typeof readyInput>((resolve) => (complete = resolve)),
  );
  const pending = submitLogin(
    page as unknown as Page,
    origin,
    'ADMIN',
    'operator',
    'PRIVATE_SUBMISSION_SENTINEL',
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(12_000);
  page.emit('response', { request: () => request, status: () => 200 });
  complete(readyInput);
  const failure = await pending;
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_POST_IN_FLIGHT_FAILED',
    submissionCheckpoint: {
      stage: 'POST_RESPONSE',
      request: 'IN_FLIGHT',
      httpStatus: null,
      ...readyInput,
    },
  });
  expect(page.click).toHaveBeenCalledTimes(1);
  closed(page);
});

it('bounds a blocked input probe and reports the first explicit transport failure', async () => {
  vi.useFakeTimers();
  const page = fakePage();
  page.click.mockImplementationOnce(async () => {
    page.emit('request', request);
    page.emit('requestfailed', request);
    page.emit('response', { request: () => request, status: () => 200 });
  });
  page.evaluate.mockImplementationOnce(() => new Promise(() => undefined));
  const pending = submitLogin(
    page as unknown as Page,
    origin,
    'ADMIN',
    'operator',
    'PRIVATE_SUBMISSION_SENTINEL',
  ).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(500);
  const failure = await pending;
  expect(failure).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_POST_REQUEST_FAILED_CONNECTION_RESET_FAILED',
    submissionCheckpoint: {
      stage: 'CLICK',
      request: 'FAILED',
      requestFailure: 'CONNECTION_RESET',
      httpStatus: null,
      inputStateAvailable: false,
    },
  });
  expect(page.click).toHaveBeenCalledTimes(1);
  closed(page);
});
