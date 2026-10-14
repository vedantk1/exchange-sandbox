import type { SessionSummaryView } from '@sandbox/contracts';
import type { Database } from '@sandbox/database';
import { sql, type Selectable, type Transaction } from 'kysely';
import { requirePrincipal, type Principal } from '../auth/access.js';
import { AuthError } from '../auth/errors.js';
import { currentCursor } from '../workspace.js';

export type HistoryTransaction = Transaction<Database>;
export type SessionRow = Selectable<Database['exchange_sessions']>;

export function sessionSummary(row: SessionRow): SessionSummaryView {
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  };
}

export async function historyContext(tx: HistoryTransaction, token: string, sessionId: string) {
  const actor = await requirePrincipal(tx, token);
  const session = await tx
    .selectFrom('exchange_sessions')
    .selectAll()
    .where('id', '=', sessionId)
    .executeTakeFirst();
  if (!session) throw new AuthError('SESSION_NOT_FOUND', 'Trading session not found.', 404);
  const now = await sql<{ as_of: Date }>`SELECT CURRENT_TIMESTAMP AS as_of`.execute(tx);
  return {
    actor,
    session,
    asOf: now.rows[0]!.as_of.toISOString(),
    cursor: await currentCursor(tx, sessionId),
  };
}

export async function scopedAccount(
  tx: HistoryTransaction,
  actor: Principal,
  accountId?: string,
): Promise<string> {
  const id = accountId ?? (actor.role === 'TRADER' ? actor.accountId : undefined);
  if (!id) throw new AuthError('ACCOUNT_REQUIRED', 'Choose an account for private history.', 400);
  if (actor.role === 'TRADER' && id !== actor.accountId)
    throw new AuthError('FORBIDDEN', 'This history is not available to this account.', 403);
  const account = await tx
    .selectFrom('accounts')
    .select('id')
    .where('id', '=', id)
    .where('kind', 'in', ['TRADER', 'FEE', 'ISSUANCE'])
    .executeTakeFirst();
  if (!account) throw new AuthError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
  return id;
}

export function encodeCursor(context: string, position: string[]): string {
  return Buffer.from(JSON.stringify({ context, position }), 'utf8').toString('base64url');
}

export function decodeCursor(
  cursor: string | undefined,
  context: string,
  fields: number,
): string[] | null {
  if (cursor === undefined) return null;
  try {
    if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      !value ||
      typeof value !== 'object' ||
      !('context' in value) ||
      value.context !== context ||
      !('position' in value)
    )
      throw new Error();
    const position = value.position;
    if (
      !Array.isArray(position) ||
      position.length !== fields ||
      position.some((item: unknown) => typeof item !== 'string' || item.length > 100)
    )
      throw new Error();
    return position as string[];
  } catch {
    throw new AuthError(
      'CURSOR_INVALID',
      'This cursor does not belong to the selected history.',
      400,
    );
  }
}

export function decimalPosition(position: string[] | null, indexes: number[]) {
  if (
    position &&
    indexes.some(
      (index) =>
        !/^(0|[1-9][0-9]{0,18})$/.test(position[index]!) ||
        BigInt(position[index]!) > 9223372036854775807n,
    )
  )
    throw new AuthError('CURSOR_INVALID', 'History cursor is invalid.', 400);
}

export function timestampPosition(position: string[] | null, index = 0): void {
  if (
    position &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(position[index]!) ||
      !Number.isFinite(Date.parse(position[index]!)) ||
      new Date(position[index]!).toISOString().slice(0, 19) !== position[index]!.slice(0, 19))
  )
    throw new AuthError('CURSOR_INVALID', 'History cursor timestamp is invalid.', 400);
}

export function uuidPosition(position: string[] | null, index: number): void {
  if (
    position &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(position[index]!)
  )
    throw new AuthError('CURSOR_INVALID', 'History cursor identity is invalid.', 400);
}

export function pageLimit(value?: string): number {
  if (value !== undefined && !/^(100|[1-9][0-9]?)$/.test(value))
    throw new AuthError('PAGE_LIMIT_INVALID', 'Choose a page size from 1 to 100.', 400);
  return Number(value ?? '50');
}

export function textPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, '\\$&')}%`;
}
