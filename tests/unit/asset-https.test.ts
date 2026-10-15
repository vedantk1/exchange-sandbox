import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readHttpsAsset, waitForHttpsAsset } from '../../scripts/deploy/asset-https.js';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request }));
vi.mock('node:timers/promises', () => ({
  setTimeout: (milliseconds: number, _value: unknown, { signal }: { signal: AbortSignal }) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        reject(signal.reason);
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    }),
}));

type Action = (
  outgoing: EventEmitter,
  response: (incoming: IncomingMessage) => void,
  options: RequestOptions,
) => void;

function transport(actions: Action[]) {
  const requests: Array<{ aborted: boolean; options: RequestOptions }> = [];
  request.mockImplementation(
    (options: RequestOptions, response: (incoming: IncomingMessage) => void) => {
      const outgoing = new EventEmitter();
      const state = { aborted: false, options };
      requests.push(state);
      const abort = () => {
        state.aborted = true;
        outgoing.emit('error', Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }));
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      outgoing.once('close', () => options.signal?.removeEventListener('abort', abort));
      Object.assign(outgoing, {
        end: () => {
          const action = actions.shift();
          if (action) action(outgoing, response, options);
        },
        destroy: (error: Error) => outgoing.emit('error', error),
      });
      return outgoing;
    },
  );
  return requests;
}

function failure(code: string, message = 'Transient connection failure'): Action {
  return (outgoing) => outgoing.emit('error', Object.assign(new Error(message), { code }));
}

function http(status = 200, body = '<html>compiled app</html>'): Action {
  return (outgoing, response) => {
    const incoming = Object.assign(new EventEmitter(), {
      statusCode: status,
      headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' },
      setEncoding: () => incoming,
    });
    response(incoming as unknown as IncomingMessage);
    incoming.emit('data', body);
    incoming.emit('end');
    outgoing.emit('close');
  };
}

beforeEach(() => {
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('trusted HTTPS asset readiness', () => {
  it('retries only transient startup failures while preserving CA and hostname validation', async () => {
    transport([
      failure('ECONNREFUSED'),
      failure('EPROTO', 'SSL routines:tlsv1 alert internal error'),
      http(),
    ]);
    const response = await waitForHttpsAsset('/history', 9443, 'generated-ca', { retryMs: 1 });
    expect(response).toEqual({
      status: 200,
      type: 'text/html',
      cache: 'no-cache',
      body: '<html>compiled app</html>',
    });
    expect(request).toHaveBeenCalledTimes(3);
    for (const [options] of request.mock.calls as Array<[RequestOptions]>) {
      expect(options).toMatchObject({
        hostname: 'localhost',
        family: 4,
        port: 9443,
        path: '/history',
        ca: 'generated-ca',
        rejectUnauthorized: true,
        agent: false,
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options).not.toHaveProperty('checkServerIdentity');
    }
  });

  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'Hostname mismatch'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'Untrusted certificate'],
    ['EPROTO', 'SSL routines:wrong version number'],
  ])('does not retry permanent TLS failure %s', async (code, message) => {
    transport([failure(code, message), http()]);
    await expect(waitForHttpsAsset('/history', 9443, 'generated-ca')).rejects.toMatchObject({
      cause: { code },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps certificate errors fatal even when they coincide with an attempt timeout', async () => {
    vi.useFakeTimers();
    request.mockImplementation((options: RequestOptions) => {
      const outgoing = new EventEmitter();
      options.signal?.addEventListener(
        'abort',
        () =>
          outgoing.emit(
            'error',
            Object.assign(new Error('Hostname mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
          ),
        { once: true },
      );
      return Object.assign(outgoing, { end: () => undefined });
    });
    const result = waitForHttpsAsset('/history', 9443, 'generated-ca', {
      timeoutMs: 60,
      attemptMs: 20,
      retryMs: 5,
    });
    const assertion = expect(result).rejects.toMatchObject({
      cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(request).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the first HTTP response for immediate content assertions without retrying HTTP failures', async () => {
    transport([http(500, 'unexpected content'), http()]);
    const response = await waitForHttpsAsset('/history', 9443, 'generated-ca');
    expect(response.status).toBe(500);
    expect(response.body).toBe('unexpected content');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not retry a transport reset after HTTP headers have arrived', async () => {
    transport([
      (_outgoing, response) => {
        const incoming = Object.assign(new EventEmitter(), { setEncoding: () => incoming });
        response(incoming as unknown as IncomingMessage);
        incoming.emit(
          'error',
          Object.assign(new Error('Interrupted response'), { code: 'ECONNRESET' }),
        );
      },
      http(),
    ]);
    await expect(waitForHttpsAsset('/history', 9443, 'generated-ca')).rejects.toMatchObject({
      cause: { code: 'ECONNRESET' },
      responseStarted: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('cancels hanging attempts and stops at its absolute deadline', async () => {
    vi.useFakeTimers();
    const requests = transport([]);
    const result = waitForHttpsAsset('/history', 9443, 'generated-ca', {
      timeoutMs: 60,
      attemptMs: 20,
      retryMs: 5,
    });
    const assertion = expect(result).rejects.toThrow('did not become ready before its deadline');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(requests).toHaveLength(3);
    expect(requests.every((entry) => entry.aborted && entry.options.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an incomplete HTTP body and never retries after the response starts', async () => {
    vi.useFakeTimers();
    const requests = transport([
      (_outgoing, response) => {
        const incoming = Object.assign(new EventEmitter(), { setEncoding: () => incoming });
        response(incoming as unknown as IncomingMessage);
        incoming.emit('data', 'partial body');
      },
    ]);
    const result = waitForHttpsAsset('/history', 9443, 'generated-ca', {
      timeoutMs: 60,
      attemptMs: 20,
      retryMs: 5,
    });
    const assertion = expect(result).rejects.toMatchObject({
      responseStarted: true,
      cause: { code: 'ABORT_ERR' },
    });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(requests).toHaveLength(1);
    expect(requests[0]?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not retry ordinary asset reads', async () => {
    transport([failure('ECONNRESET'), http()]);
    await expect(readHttpsAsset('/assets/app.js', 9443, 'generated-ca')).rejects.toMatchObject({
      cause: { code: 'ECONNRESET' },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
