import type {
  OrderDetailResponse,
  WorkspaceOrderView,
  WorkspaceFillView,
} from '@sandbox/contracts';

export interface User {
  accountId: string;
  handle: string;
  role: 'ADMIN' | 'TRADER';
}

export interface CommandOutcome {
  commandId: string;
  sessionId: string;
  sequence: string;
  status: 'ACCEPTED' | 'REJECTED';
  code?: string;
  order?: Partial<WorkspaceOrderView> & { id: string };
  fills?: Partial<WorkspaceFillView>[];
  data?: Record<string, unknown>;
  token?: string;
}

export type OrderDetailView = OrderDetailResponse;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string {
  const value = document.cookie.split('; ').find((cookie) => cookie.startsWith('sandbox_csrf='));
  return value ? decodeURIComponent(value.slice('sandbox_csrf='.length)) : '';
}

export async function api<T>(
  path: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
  actorId?: string,
): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() }),
      ...(actorId ? { 'X-Sandbox-Actor': actorId } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
      : AbortSignal.timeout(20_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new ApiError(
      response.status,
      result.code ?? 'REQUEST_FAILED',
      result.message ?? 'The request could not be completed.',
    );
  return result as T;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'The server could not be reached. Check the connection and try again.';
}

export function readableCode(code: string): string {
  const explanations: Record<string, string> = {
    INSUFFICIENT_FUNDS: 'There are not enough available funds for this order.',
    MARKET_PAUSED: 'Trading is paused. Existing orders can still be canceled.',
    STALE_SESSION: 'The trading session changed. Review the current session before continuing.',
    ORDER_TOO_SMALL: 'The order must have a notional value of at least 1 USD-SIM.',
    OPEN_ORDER_LIMIT: 'The account already has 50 open orders. Cancel a remaining order first.',
    RECOVERY_REQUIRED: 'An accounting check requires administrator attention.',
    INVARIANT_FAILURE: 'The command was rolled back after an accounting check failed.',
    MARKET_MUST_BE_PAUSED: 'Pause trading before granting virtual funds.',
    PENDING_CANCELLATION: 'Order cancellation is pending reconciliation.',
    SELF_TRADE_PREVENTION: 'The remainder was canceled to prevent trading with your own order.',
  };
  return explanations[code] ?? code.toLowerCase().replaceAll('_', ' ');
}
