import type { HistoryKind } from './types.js';

export interface HistoryLocation {
  /** An omitted session follows the active session; an explicit archive stays selected. */
  sessionId: string | null;
  accountId: string | null;
  kind: HistoryKind;
  search: string;
  side: 'ALL' | 'BUY' | 'SELL';
  status: 'ALL' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';
}

const keys = ['session', 'account', 'kind', 'search', 'side', 'status'] as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function one(parameters: URLSearchParams, key: string): string | null {
  const values = parameters.getAll(key);
  return values.length === 1 ? values[0]! : null;
}

/** URL values select a view only. Role, ownership, and session membership remain server checks. */
export function readHistoryLocation(
  parameters: URLSearchParams,
  actorId: string,
  admin: boolean,
): HistoryLocation {
  const session = one(parameters, 'session');
  const account = one(parameters, 'account');
  const kind = one(parameters, 'kind');
  const search = one(parameters, 'search')?.trim() ?? '';
  const side = one(parameters, 'side');
  const status = one(parameters, 'status');
  return {
    sessionId: session && uuid.test(session) ? session : null,
    accountId: admin ? (account && uuid.test(account) ? account : null) : actorId,
    kind:
      kind &&
      ['orders', 'fills', 'activity', 'commands', ...(admin ? ['audit'] : [])].includes(kind)
        ? (kind as HistoryKind)
        : admin
          ? 'audit'
          : 'fills',
    search: search.length <= 80 && !/[\u0000-\u001f\u007f]/.test(search) ? search : '',
    side: side === 'BUY' || side === 'SELL' ? side : 'ALL',
    status:
      status && ['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED'].includes(status)
        ? (status as HistoryLocation['status'])
        : 'ALL',
  };
}

/** Omit default values and transient pagination/download capabilities from browser history. */
export function writeHistoryLocation(
  parameters: URLSearchParams,
  value: HistoryLocation,
  admin: boolean,
): URLSearchParams {
  const result = new URLSearchParams(parameters);
  for (const key of keys) result.delete(key);
  if (value.sessionId) result.set('session', value.sessionId);
  if (admin && value.accountId) result.set('account', value.accountId);
  if (value.kind !== (admin ? 'audit' : 'fills')) result.set('kind', value.kind);
  if (value.search) result.set('search', value.search);
  if (value.side !== 'ALL') result.set('side', value.side);
  if (value.status !== 'ALL') result.set('status', value.status);
  return result;
}

export function clearHistoryLocation(parameters: URLSearchParams): URLSearchParams {
  const result = new URLSearchParams(parameters);
  for (const key of keys) result.delete(key);
  return result;
}
