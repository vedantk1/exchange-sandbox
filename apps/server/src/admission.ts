import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Diagnostics } from './diagnostics.js';
import { diagnosticContext } from './diagnostic-context.js';
import { diagnosticOutcome } from './diagnostic-outcome.js';
import type { DiagnosticOutcome } from './diagnostics.js';

// Prototype resource bounds, not measured throughput or latency guarantees.
export const MAX_ACTIVE_REQUESTS = 64;
export const ADMISSION_DEADLINE_MS = 8_000;
export const COMMAND_LOCK_TIMEOUT_MS = 2_000;

export class AdmissionError extends Error {
  readonly statusCode = 503;

  constructor(readonly code: 'ADMISSION_BUSY' | 'ADMISSION_EXPIRED' | 'REQUEST_ABORTED') {
    super('The request was not admitted. Resolve or retry its original command identity.');
  }
}

interface AdmissionScope {
  signal: AbortSignal;
  deadline: number;
  admitted: boolean;
  rejected?: (code: AdmissionError['code']) => void;
}

const scopeStorage = new AsyncLocalStorage<AdmissionScope>();

function assertPending(scope: AdmissionScope): void {
  // Once admitted, a command completes atomically despite a lost HTTP client.
  // This also permits its fault-persistence fallback to finish safely.
  if (scope.admitted) return;
  const code = scope.signal.aborted
    ? 'REQUEST_ABORTED'
    : performance.now() >= scope.deadline
      ? 'ADMISSION_EXPIRED'
      : undefined;
  if (code) {
    scope.rejected?.(code);
    throw new AdmissionError(code);
  }
}

export function checkPendingAdmission(): void {
  const scope = scopeStorage.getStore();
  if (scope) assertPending(scope);
}

/** Call after the authoritative control lock and before any protected mutation. */
export function admitRequest(): void {
  const scope = scopeStorage.getStore();
  if (!scope) return; // Trusted local CLI and domain tests do not own HTTP requests.
  assertPending(scope);
  scope.admitted = true;
}

export interface HttpAdmissionOptions {
  maxActiveRequests?: number;
  deadlineMs?: number;
}

interface RequestState {
  controller: AbortController;
  scope: AdmissionScope;
  work: number;
  handlerFinished: boolean;
  responseFinished: boolean;
  disconnected: boolean;
  released: boolean;
  cleanup: () => void;
}

/** No queue: a slot includes body parsing, authorization, and the route handler. */
export function installHttpAdmission(
  app: FastifyInstance,
  options: HttpAdmissionOptions = {},
  diagnostics?: Diagnostics,
) {
  const maxActiveRequests = options.maxActiveRequests ?? MAX_ACTIVE_REQUESTS;
  const deadlineMs = options.deadlineMs ?? ADMISSION_DEADLINE_MS;
  if (
    !Number.isSafeInteger(maxActiveRequests) ||
    maxActiveRequests < 1 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1
  ) {
    throw new Error('Admission limits must be positive integers.');
  }
  let activeRequests = 0;
  const requests = new WeakMap<FastifyRequest, RequestState>();

  function releaseWhenFinished(state: RequestState): void {
    if (state.released || state.work !== 0) return;
    if (!state.handlerFinished && !state.responseFinished && !state.disconnected) return;
    state.released = true;
    activeRequests -= 1;
    diagnostics?.gauge('http.active_requests', activeRequests);
    state.cleanup();
  }

  function disconnect(state: RequestState): void {
    state.disconnected = true;
    state.controller.abort();
    // A closed socket must not free capacity while its DB work is still queued.
    releaseWhenFinished(state);
  }

  async function run<T>(
    request: FastifyRequest,
    work: () => T,
    handler = false,
  ): Promise<Awaited<T>> {
    const state = requests.get(request);
    if (!state) throw new AdmissionError('ADMISSION_BUSY');
    assertPending(state.scope);
    state.work += 1;
    const context = diagnosticContext(request);
    const command = handler && context.commandId !== undefined && context.sessionId !== undefined;
    const started = performance.now();
    const record = (outcome: DiagnosticOutcome, result?: unknown) => {
      if (!command || !diagnostics) return;
      diagnostics.observe('http.command', performance.now() - started, outcome);
      // Matching owns its commit/replay distinction, including lost after-commit replies.
      if (['limit_order', 'market_order', 'cancel_order'].includes(context.operation ?? '')) return;
      const sequence = (result as { sequence?: unknown } | undefined)?.sequence;
      diagnostics.event('command.completed', {
        ...context,
        outcome,
        ...(typeof sequence === 'string' ? { sequence } : {}),
      });
    };
    try {
      const result = await scopeStorage.run(state.scope, () =>
        diagnostics ? diagnostics.run(diagnosticContext(request), work) : work(),
      );
      const status = (result as { status?: unknown } | null)?.status;
      record(
        status === 'ACCEPTED' ? 'accepted' : status === 'REJECTED' ? 'rejected' : 'ok',
        result,
      );
      return result;
    } catch (error) {
      record(diagnosticOutcome(error));
      throw error;
    } finally {
      state.work -= 1;
      if (handler) state.handlerFinished = true;
      releaseWhenFinished(state);
    }
  }

  app.addHook('onRequest', async (request, reply) => {
    if (activeRequests >= maxActiveRequests) {
      diagnostics?.event('admission.rejected', { ...diagnosticContext(request), outcome: 'busy' });
      throw new AdmissionError('ADMISSION_BUSY');
    }
    let reported = false;
    const controller = new AbortController();
    const state: RequestState = {
      controller,
      scope: {
        signal: controller.signal,
        deadline: performance.now() + deadlineMs,
        admitted: false,
        rejected: (code) => {
          if (reported) return;
          reported = true;
          diagnostics?.event('admission.rejected', {
            ...diagnosticContext(request),
            outcome: code === 'REQUEST_ABORTED' ? 'aborted' : 'timeout',
          });
        },
      },
      work: 0,
      handlerFinished: false,
      responseFinished: false,
      disconnected: false,
      released: false,
      cleanup: () => undefined,
    };
    const onAborted = () => disconnect(state);
    const onClosed = () => {
      // IncomingMessage 'close' also occurs after normally reading a request.
      // ServerResponse 'close' before finish identifies an observed lost reply.
      if (!reply.raw.writableFinished) disconnect(state);
    };
    state.cleanup = () => {
      request.raw.off('aborted', onAborted);
      reply.raw.off('close', onClosed);
    };
    activeRequests += 1;
    diagnostics?.gauge('http.active_requests', activeRequests);
    requests.set(request, state);
    request.raw.once('aborted', onAborted);
    reply.raw.once('close', onClosed);
  });
  app.addHook('onTimeout', async (request) => {
    const state = requests.get(request);
    if (state) disconnect(state);
  });
  app.addHook('onResponse', async (request) => {
    const state = requests.get(request);
    if (!state) return;
    state.responseFinished = true;
    releaseWhenFinished(state);
  });
  app.addHook('onRoute', (route) => {
    const handler = route.handler;
    route.handler = function (request, reply) {
      return run(request, () => handler.call(this, request, reply), true);
    };
  });
  return {
    run,
    requestSignal(request: FastifyRequest): AbortSignal {
      const state = requests.get(request);
      if (!state) throw new AdmissionError('ADMISSION_BUSY');
      return state.controller.signal;
    },
  };
}
