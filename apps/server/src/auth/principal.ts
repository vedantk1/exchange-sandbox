import type { Database } from '@sandbox/database';
import { sql, type Transaction } from 'kysely';
import { equalHash, tokenHash } from './crypto.js';
import { AuthError, unauthenticated } from './errors.js';

export interface UserView {
  accountId: string;
  handle: string;
  role: 'ADMIN' | 'TRADER';
}

export interface Principal extends UserView {
  sessionHash: string;
}

/** Call within the same locked transaction as the protected mutation. */
export async function requirePrincipalHash(
  tx: Transaction<Database>,
  sessionHash: string,
  role?: 'ADMIN' | 'TRADER',
  csrfToken?: string,
): Promise<Principal> {
  if (
    typeof sessionHash !== 'string' ||
    sessionHash.length !== 64 ||
    !/^[a-f0-9]{64}$/.test(sessionHash)
  )
    throw unauthenticated();
  const row = await tx
    .selectFrom('login_sessions')
    .innerJoin('users', 'users.account_id', 'login_sessions.account_id')
    .select([
      'users.account_id',
      'users.handle',
      'users.role',
      'users.status',
      'login_sessions.csrf_hash',
    ])
    .where('login_sessions.token_hash', '=', sessionHash)
    .where('login_sessions.revoked_at', 'is', null)
    .where('login_sessions.expires_at', '>', sql<Date>`clock_timestamp()`)
    .executeTakeFirst();
  if (!row || row.status !== 'ACTIVE') throw unauthenticated();
  if (role !== undefined && row.role !== role)
    throw new AuthError('FORBIDDEN', 'This action is not available to this account.', 403);
  if (csrfToken !== undefined) {
    const hash = tokenHash(csrfToken);
    if (!hash || !equalHash(row.csrf_hash, hash))
      throw new AuthError('CSRF_INVALID', 'A valid CSRF token is required.', 403);
  }
  return { accountId: row.account_id, handle: row.handle, role: row.role, sessionHash };
}

export async function requirePrincipal(
  tx: Transaction<Database>,
  token: string,
  role?: 'ADMIN' | 'TRADER',
  csrfToken?: string,
): Promise<Principal> {
  const hash = tokenHash(token);
  if (!hash) throw unauthenticated();
  return requirePrincipalHash(tx, hash, role, csrfToken);
}
