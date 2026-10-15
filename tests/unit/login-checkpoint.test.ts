import { EventEmitter } from 'node:events';
import type { Page, Request } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatLoginCheckpoint,
  networkFailure,
  openLoginPage,
} from '../../scripts/deploy/acceptance/login.js';

it('retains the reproduced Linux network-change category without exposing browser text', () => {
  const request = {
    failure: () => ({ errorText: 'net::ERR_NETWORK_CHANGED' }),
  } as Request;
  expect(networkFailure(request)).toBe('NETWORK_CHANGED');
  expect(
    JSON.parse(formatLoginCheckpoint({ sessionFailure: networkFailure(request) })!),
  ).toMatchObject({ sessionFailure: 'NETWORK_CHANGED' });
  expect(
    networkFailure({ failure: () => ({ errorText: 'PRIVATE_NETWORK_SENTINEL' }) } as Request),
  ).toBe('OTHER');
});

describe('sanitized login checkpoint output', () => {
  it('copies only fixed categories and bounded counters without diagnostic payloads', () => {
    const secret = 'PRIVATE_CHECKPOINT_SENTINEL';
    const output = formatLoginCheckpoint({
      documentLoaded: true,
      scriptRequests: 1000,
      scriptResponses: 2,
      scriptHttpStatus: 503,
      scriptFailure: 'CERTIFICATE',
      session: 'FAILED',
      sessionFailure: 'HTTP2_PROTOCOL',
      pageErrors: 1,
      capabilities: 'AVAILABLE',
      url: secret,
      message: secret,
      body: secret,
      token: secret,
      error: new Error(secret),
    });
    expect(JSON.parse(output!)).toEqual({
      documentLoaded: true,
      scriptRequests: 255,
      scriptResponses: 2,
      scriptHttpStatus: 503,
      scriptFailure: 'CERTIFICATE',
      session: 'FAILED',
      sessionFailure: 'HTTP2_PROTOCOL',
      pageErrors: 1,
      capabilities: 'AVAILABLE',
    });
    expect(output).not.toContain(secret);
  });

  it('replaces invalid runtime fields without echoing unknown error categories', () => {
    const secret = 'PRIVATE_CHECKPOINT_SENTINEL';
    const output = formatLoginCheckpoint({
      documentLoaded: secret,
      scriptRequests: Infinity,
      scriptResponses: -1,
      scriptHttpStatus: 999,
      scriptFailure: secret,
      session: secret,
      sessionFailure: secret,
      pageErrors: '8',
      capabilities: secret,
    });
    expect(JSON.parse(output!)).toEqual({
      documentLoaded: false,
      scriptRequests: 0,
      scriptResponses: 0,
      scriptHttpStatus: null,
      scriptFailure: null,
      session: 'NOT_REQUESTED',
      sessionFailure: null,
      pageErrors: 0,
      capabilities: 'UNAVAILABLE',
    });
    expect(output).not.toContain(secret);
  });

  it('omits absent or getter-backed invalid inputs without propagating failures', () => {
    expect(formatLoginCheckpoint(undefined)).toBeUndefined();
    expect(formatLoginCheckpoint('PRIVATE_CHECKPOINT_SENTINEL')).toBeUndefined();
    expect(
      formatLoginCheckpoint(
        Object.defineProperty({}, 'documentLoaded', {
          get() {
            throw new Error('PRIVATE_CHECKPOINT_SENTINEL');
          },
        }),
      ),
    ).toBeUndefined();
  });
});

it('reads getter-backed checkpoint fields once before validating their primitive values', () => {
  const calls = { session: 0, capabilities: 0, scriptHttpStatus: 0 };
  const checkpoint = Object.defineProperties(
    {},
    {
      session: {
        get() {
          return ++calls.session === 1 ? 'FAILED' : 'PRIVATE_GETTER_SENTINEL';
        },
      },
      capabilities: {
        get() {
          return ++calls.capabilities === 1 ? 'AVAILABLE' : 'PRIVATE_GETTER_SENTINEL';
        },
      },
      scriptHttpStatus: {
        get() {
          return ++calls.scriptHttpStatus === 1 ? 503 : 999;
        },
      },
    },
  );
  const output = formatLoginCheckpoint(checkpoint);
  expect(JSON.parse(output!)).toMatchObject({
    session: 'FAILED',
    capabilities: 'AVAILABLE',
    scriptHttpStatus: 503,
  });
  expect(output).not.toContain('PRIVATE_GETTER_SENTINEL');
  expect(calls).toEqual({ session: 1, capabilities: 1, scriptHttpStatus: 1 });
});

const origin = 'https://localhost:9443';
const sessionRequest = {
  url: () => `${origin}/api/auth/session`,
  method: () => 'GET',
  resourceType: () => 'fetch',
};

function fakePage(evaluate: () => Promise<string>) {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    goto: vi.fn(async () => {
      emitter.emit('request', sessionRequest);
      return { status: () => 200 };
    }),
    evaluate: vi.fn(evaluate),
  });
}

function expectClosed(page: EventEmitter) {
  for (const event of ['request', 'response', 'requestfailed', 'pageerror']) {
    expect(page.listenerCount(event)).toBe(0);
  }
  expect(vi.getTimerCount()).toBe(0);
}

afterEach(() => vi.useRealTimers());

it('preserves timeout checkpoint when a late session response arrives during capability probing', async () => {
  vi.useFakeTimers();
  let complete!: (value: string) => void;
  const probe = new Promise<string>((resolve) => {
    complete = resolve;
  });
  const page = fakePage(() => probe);
  const result = openLoginPage(page as unknown as Page, origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(12_000);
  expect(page.evaluate).toHaveBeenCalledTimes(1);
  page.emit('response', { request: () => sessionRequest, status: () => 401 });
  complete('AVAILABLE');
  const error = await result;
  expect(error).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED',
    checkpoint: { documentLoaded: true, session: 'IN_FLIGHT', capabilities: 'AVAILABLE' },
  });
  expectClosed(page);
});

it('preserves the first explicit failure even if navigation finishes after late session activity', async () => {
  vi.useFakeTimers();
  const page = fakePage(async () => 'AVAILABLE');
  const script = {
    url: () => `${origin}/assets/index-test.js`,
    resourceType: () => 'script',
    failure: () => ({ errorText: 'net::ERR_CONNECTION_RESET' }),
  };
  page.goto.mockImplementation(async () => {
    page.emit('request', script);
    page.emit('requestfailed', script);
    page.emit('request', sessionRequest);
    page.emit('response', { request: () => sessionRequest, status: () => 401 });
    return { status: () => 200 };
  });
  const error = await openLoginPage(page as unknown as Page, origin, 'ADMIN').catch(
    (failure: unknown) => failure,
  );
  expect(error).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_ENTRY_SCRIPT_REQUEST_FAILED_CONNECTION_RESET_FAILED',
    checkpoint: {
      documentLoaded: true,
      session: 'NOT_REQUESTED',
      scriptFailure: 'CONNECTION_RESET',
    },
  });
  expectClosed(page);
});

it('bounds a stalled capability probe and removes deadline listeners and timers in finally', async () => {
  vi.useFakeTimers();
  const page = fakePage(() => new Promise<string>(() => undefined));
  const result = openLoginPage(page as unknown as Page, origin, 'ADMIN').catch(
    (error: unknown) => error,
  );
  await vi.advanceTimersByTimeAsync(12_500);
  expect(await result).toMatchObject({
    code: 'ACCEPTANCE_LOGIN_ADMIN_SESSION_IN_FLIGHT_FAILED',
    checkpoint: { session: 'IN_FLIGHT', capabilities: 'UNAVAILABLE' },
  });
  expectClosed(page);
});
