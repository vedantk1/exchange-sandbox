import { randomUUID } from 'node:crypto';
import type { Database } from '@sandbox/database';
import { sql, type Transaction } from 'kysely';
import {
  appendAudit,
  fingerprint,
  loadReceipt,
  nextSequence,
  persistAdminResult,
  validateId,
  validateReason,
  type Control,
} from '../admin/commands.js';
import { allocateTrader, initializeSession } from '../core-mutations.js';
import type { Exchange } from '../exchange.js';
import { canonicalHandle, hashPassword, newToken, tokenHash, verifyPassword } from './crypto.js';
import { AuthError } from './errors.js';
import { requireNoRollover } from '../session-lifecycle.js';
import { requirePrincipal, type Principal, type UserView } from './principal.js';

const SESSION_DURATION = 12 * 60 * 60 * 1_000;
const INVITATION_DURATION = 24 * 60 * 60 * 1_000;
const RECOVERY_DURATION = 60 * 60 * 1_000;

export interface LoginResult {
  token: string;
  csrfToken: string;
  expiresAt: string;
  user: UserView;
}

export interface AccessCommand {
  commandId: string;
  sessionId: string;
  reason: string;
}

export interface AccessResult {
  commandId: string;
  sessionId: string;
  sequence: string;
  status: 'ACCEPTED' | 'REJECTED';
  code?: string;
  data?: Record<string, unknown>;
  /** One-time handoff only. This field is never included in a receipt or audit. */
  token?: string;
}

type AccessOutcome = Pick<AccessResult, 'status' | 'code' | 'data'> & { token?: string };

async function databaseTime(tx: Transaction<Database>): Promise<Date> {
  const result = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
  return result.rows[0]!.now;
}

async function startSession(tx: Transaction<Database>, user: UserView): Promise<LoginResult> {
  const token = newToken();
  const csrfToken = newToken();
  const now = await databaseTime(tx);
  const expiresAt = new Date(now.getTime() + SESSION_DURATION);
  await tx
    .insertInto('login_sessions')
    .values({
      token_hash: tokenHash(token)!,
      csrf_hash: tokenHash(csrfToken)!,
      account_id: user.accountId,
      expires_at: expiresAt,
      revoked_at: null,
    })
    .execute();
  return { token, csrfToken, expiresAt: expiresAt.toISOString(), user };
}

async function revokeSessions(
  tx: Transaction<Database>,
  accountId: string,
  now: Date,
): Promise<void> {
  await tx
    .updateTable('login_sessions')
    .set({ revoked_at: now })
    .where('account_id', '=', accountId)
    .where('revoked_at', 'is', null)
    .execute();
}

/** Identity operations share the exchange admission lock with financial commands. */
export class AuthService {
  constructor(private readonly exchange: Exchange) {}

  /** Owner-only local CLI operation. Never expose this method as an HTTP route. */
  async bootstrapAdmin(input: {
    handle: string;
    password: string;
  }): Promise<UserView & { sessionId: string }> {
    const handle = canonicalHandle(input.handle);
    const passwordHash = await hashPassword(input.password);
    return this.exchange.financialTransaction(async (tx, control) => {
      const existing = await tx
        .selectFrom('users')
        .select('account_id')
        .where('role', '=', 'ADMIN')
        .executeTakeFirst();
      if (existing)
        throw new AuthError('ALREADY_INITIALIZED', 'An administrator already exists.', 409);
      const usedHandle = await tx
        .selectFrom('users')
        .select('account_id')
        .where('handle', '=', handle)
        .executeTakeFirst();
      if (usedHandle) throw new AuthError('HANDLE_UNAVAILABLE', 'Choose another handle.', 409);
      const { sessionId } = await initializeSession(tx, { marketState: 'PAUSED' });
      await tx
        .updateTable('exchange_control')
        .set({ market_state: 'PAUSED' })
        .where('id', '=', 1)
        .execute();
      const accountId = randomUUID();
      const commandId = randomUUID();
      await tx
        .insertInto('accounts')
        .values({ id: accountId, kind: 'ADMIN', label: handle })
        .execute();
      await tx
        .insertInto('users')
        .values({
          account_id: accountId,
          role: 'ADMIN',
          handle,
          password_hash: passwordHash,
          status: 'ACTIVE',
          suspension_reason: null,
          pending_cancellation: false,
        })
        .execute();
      await nextSequence(tx, control);
      await appendAudit(tx, {
        actorId: accountId,
        commandId,
        sessionId,
        action: 'ADMIN_BOOTSTRAPPED',
        targetId: accountId,
        reason: 'Local owner setup.',
        result: { status: 'ACCEPTED' },
      });
      return { accountId, handle, role: 'ADMIN', sessionId };
    });
  }

  /** Owner-only lost-access recovery; all existing administrator sessions expire. */
  async resetAdminPassword(input: { password: string }): Promise<UserView> {
    const passwordHash = await hashPassword(input.password);
    return this.exchange.accessTransaction(async (tx, control) => {
      const user = await tx
        .selectFrom('users')
        .selectAll()
        .where('role', '=', 'ADMIN')
        .executeTakeFirst();
      if (!user) throw new AuthError('NOT_INITIALIZED', 'Set up the administrator first.', 409);
      const now = await databaseTime(tx);
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, updated_at: now })
        .where('account_id', '=', user.account_id)
        .execute();
      await revokeSessions(tx, user.account_id, now);
      await nextSequence(tx, control);
      await appendAudit(tx, {
        actorId: user.account_id,
        commandId: randomUUID(),
        sessionId: control.active_session_id,
        action: 'ADMIN_PASSWORD_RESET',
        targetId: user.account_id,
        reason: 'Local owner recovery.',
        result: { status: 'ACCEPTED' },
      });
      return { accountId: user.account_id, handle: user.handle, role: user.role };
    });
  }

  async login(input: { handle: string; password: string }): Promise<LoginResult> {
    input = { ...input };
    // Handle-format failures use the same response as bad credentials.
    let handle: string;
    try {
      handle = canonicalHandle(input.handle);
    } catch {
      handle = '';
    }
    const candidate = await this.exchange.readTransaction((tx) =>
      tx
        .selectFrom('users')
        .select(['account_id', 'password_hash'])
        .where('handle', '=', handle)
        .executeTakeFirst(),
    );
    if (!(await verifyPassword(candidate?.password_hash, input.password)))
      throw new AuthError('INVALID_CREDENTIALS', 'The handle or password is incorrect.', 401);
    return this.exchange.accessTransaction(async (tx) => {
      const user = await tx
        .selectFrom('users')
        .selectAll()
        .where('account_id', '=', candidate!.account_id)
        .executeTakeFirst();
      // Password recovery and suspension can happen while Argon2 runs outside the lock.
      if (!user || user.password_hash !== candidate!.password_hash || user.status !== 'ACTIVE')
        throw new AuthError('INVALID_CREDENTIALS', 'The handle or password is incorrect.', 401);
      return startSession(tx, { accountId: user.account_id, handle: user.handle, role: user.role });
    });
  }

  async authenticate(token: string, csrfToken?: string): Promise<Principal> {
    return this.exchange.readTransaction((tx) => requirePrincipal(tx, token, undefined, csrfToken));
  }

  async logout(token: string): Promise<void> {
    const hash = tokenHash(token);
    if (!hash) return;
    await this.exchange.accessTransaction(async (tx) => {
      await tx
        .updateTable('login_sessions')
        .set({ revoked_at: await databaseTime(tx) })
        .where('token_hash', '=', hash)
        .where('revoked_at', 'is', null)
        .execute();
    });
  }

  async changePassword(
    token: string,
    input: { currentPassword: string; newPassword: string },
  ): Promise<LoginResult> {
    input = { ...input };
    const candidate = await this.exchange.readTransaction(async (tx) => {
      const principal = await requirePrincipal(tx, token);
      return tx
        .selectFrom('users')
        .selectAll()
        .where('account_id', '=', principal.accountId)
        .executeTakeFirstOrThrow();
    });
    if (!(await verifyPassword(candidate.password_hash, input.currentPassword)))
      throw new AuthError('INVALID_CREDENTIALS', 'The current password is incorrect.', 401);
    const passwordHash = await hashPassword(input.newPassword);
    return this.exchange.accessTransaction(async (tx, control) => {
      const principal = await requirePrincipal(tx, token);
      const current = await tx
        .selectFrom('users')
        .select('password_hash')
        .where('account_id', '=', principal.accountId)
        .executeTakeFirstOrThrow();
      if (current.password_hash !== candidate.password_hash)
        throw new AuthError('CREDENTIALS_CHANGED', 'Credentials changed; sign in again.', 409);
      const now = await databaseTime(tx);
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, updated_at: now })
        .where('account_id', '=', principal.accountId)
        .execute();
      await revokeSessions(tx, principal.accountId, now);
      // A self-service password change also invalidates any outstanding reset link.
      await tx
        .updateTable('recovery_tokens')
        .set({ revoked_at: now })
        .where('account_id', '=', principal.accountId)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      await nextSequence(tx, control);
      await appendAudit(tx, {
        actorId: principal.accountId,
        commandId: randomUUID(),
        sessionId: control.active_session_id,
        action: 'PASSWORD_CHANGED',
        targetId: principal.accountId,
        reason: 'Account owner changed password.',
        result: { status: 'ACCEPTED' },
      });
      return startSession(tx, {
        accountId: principal.accountId,
        handle: principal.handle,
        role: principal.role,
      });
    });
  }

  private async adminCommand(
    token: string,
    input: AccessCommand,
    action: string,
    targetId: string | null,
    extra: Record<string, unknown>,
    execute: (
      tx: Transaction<Database>,
      principal: Principal,
      control: Control,
    ) => Promise<AccessOutcome>,
  ): Promise<AccessResult> {
    input = { ...input };
    validateId(input.commandId);
    validateId(input.sessionId);
    const reason = validateReason(input.reason);
    const hash = fingerprint({ action, sessionId: input.sessionId, reason, ...extra });
    let secret: string | undefined;
    const result = await this.exchange.accessTransaction(async (tx, control) => {
      const principal = await requirePrincipal(tx, token, 'ADMIN');
      const prior = await loadReceipt(tx, principal.accountId, input.commandId, hash);
      if (prior) return prior as unknown as AccessResult;
      const sequence = await nextSequence(tx, control);
      const outcome =
        control.active_session_id === input.sessionId
          ? await execute(tx, principal, control)
          : { status: 'REJECTED' as const, code: 'STALE_SESSION' };
      const { token: issuedToken, ...publicOutcome } = outcome;
      secret = issuedToken;
      const result: AccessResult = {
        commandId: input.commandId,
        sessionId: input.sessionId,
        sequence,
        ...publicOutcome,
      };
      await persistAdminResult(tx, {
        actorId: principal.accountId,
        commandId: input.commandId,
        sessionId: input.sessionId,
        hash,
        sequence,
        action,
        targetId,
        reason,
        result: { ...result },
      });
      return result;
    });
    return secret === undefined ? result : { ...result, token: secret };
  }

  async issueInvitation(token: string, input: AccessCommand): Promise<AccessResult> {
    input = { ...input };
    return this.adminCommand(
      token,
      input,
      'INVITATION_CREATED',
      null,
      {},
      async (tx, principal) => {
        const id = randomUUID();
        const secret = newToken();
        const now = await databaseTime(tx);
        const expiresAt = new Date(now.getTime() + INVITATION_DURATION);
        await tx
          .insertInto('invitations')
          .values({
            id,
            token_hash: tokenHash(secret)!,
            created_by: principal.accountId,
            expires_at: expiresAt,
            revoked_at: null,
            redeemed_at: null,
            redeemed_by: null,
          })
          .execute();
        return {
          status: 'ACCEPTED',
          data: { id, expiresAt: expiresAt.toISOString() },
          token: secret,
        };
      },
    );
  }

  async revokeInvitation(
    token: string,
    input: AccessCommand & { invitationId: string },
  ): Promise<AccessResult> {
    input = { ...input };
    validateId(input.invitationId);
    return this.adminCommand(
      token,
      input,
      'INVITATION_REVOKED',
      input.invitationId,
      { invitationId: input.invitationId },
      async (tx) => {
        const invitation = await tx
          .selectFrom('invitations')
          .selectAll()
          .where('id', '=', input.invitationId)
          .executeTakeFirst();
        if (!invitation) return { status: 'REJECTED', code: 'INVITATION_NOT_FOUND' };
        if (invitation.redeemed_at)
          return { status: 'REJECTED', code: 'INVITATION_ALREADY_REDEEMED' };
        if (!invitation.revoked_at)
          await tx
            .updateTable('invitations')
            .set({ revoked_at: await databaseTime(tx) })
            .where('id', '=', invitation.id)
            .execute();
        return { status: 'ACCEPTED', data: { id: invitation.id, state: 'REVOKED' } };
      },
    );
  }

  async listInvitations(token: string) {
    return this.exchange.readTransaction(async (tx) => {
      await requirePrincipal(tx, token, 'ADMIN');
      const now = await databaseTime(tx);
      const rows = await tx
        .selectFrom('invitations')
        .select(['id', 'created_at', 'expires_at', 'revoked_at', 'redeemed_at', 'redeemed_by'])
        .orderBy('created_at', 'desc')
        .limit(200)
        .execute();
      return rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
        state: row.redeemed_at
          ? 'REDEEMED'
          : row.revoked_at
            ? 'REVOKED'
            : row.expires_at <= now
              ? 'EXPIRED'
              : 'PENDING',
        redeemedBy: row.redeemed_by,
      }));
    });
  }

  async redeemInvitation(input: {
    token: string;
    handle: string;
    password: string;
  }): Promise<UserView & { sessionId: string }> {
    const hash = tokenHash(input.token);
    if (!hash)
      throw new AuthError(
        'INVITATION_UNAVAILABLE',
        'The invitation is invalid, expired, revoked, or already used.',
        400,
      );
    const handle = canonicalHandle(input.handle);
    const passwordHash = await hashPassword(input.password);
    return this.exchange.financialTransaction(async (tx, control) => {
      requireNoRollover(control);
      const invitation = await tx
        .selectFrom('invitations')
        .selectAll()
        .where('token_hash', '=', hash)
        .executeTakeFirst();
      const now = await databaseTime(tx);
      if (
        !invitation ||
        invitation.revoked_at ||
        invitation.redeemed_at ||
        invitation.expires_at <= now
      )
        throw new AuthError(
          'INVITATION_UNAVAILABLE',
          'The invitation is invalid, expired, revoked, or already used.',
          400,
        );
      const sessionId = control.active_session_id;
      if (!sessionId)
        throw new AuthError('NOT_INITIALIZED', 'The exchange is not initialized.', 503);
      const taken = await tx
        .selectFrom('users')
        .select('account_id')
        .where('handle', '=', handle)
        .executeTakeFirst();
      if (taken) throw new AuthError('HANDLE_UNAVAILABLE', 'Choose another handle.', 409);
      const accountId = randomUUID();
      const commandId = randomUUID();
      await tx
        .insertInto('accounts')
        .values({ id: accountId, kind: 'TRADER', label: handle })
        .execute();
      await tx
        .insertInto('users')
        .values({
          account_id: accountId,
          role: 'TRADER',
          handle,
          password_hash: passwordHash,
          status: 'ACTIVE',
          suspension_reason: null,
          pending_cancellation: false,
        })
        .execute();
      await allocateTrader(tx, sessionId, accountId, commandId);
      await tx
        .updateTable('invitations')
        .set({ redeemed_at: now, redeemed_by: accountId })
        .where('id', '=', invitation.id)
        .execute();
      const sequence = await nextSequence(tx, control);
      const user = { accountId, handle, role: 'TRADER' as const, sessionId };
      await persistAdminResult(tx, {
        actorId: accountId,
        commandId,
        sessionId,
        hash: fingerprint({ action: 'INVITATION_REDEEMED', invitationId: invitation.id }),
        sequence,
        action: 'INVITATION_REDEEMED',
        targetId: invitation.id,
        reason: 'Trader redeemed an invitation.',
        result: { ...user },
      });
      return user;
    });
  }

  async issueRecovery(
    token: string,
    input: AccessCommand & { accountId: string },
  ): Promise<AccessResult> {
    input = { ...input };
    validateId(input.accountId);
    return this.adminCommand(
      token,
      input,
      'RECOVERY_ISSUED',
      input.accountId,
      { accountId: input.accountId },
      async (tx, principal) => {
        const user = await tx
          .selectFrom('users')
          .select(['account_id', 'role'])
          .where('account_id', '=', input.accountId)
          .executeTakeFirst();
        if (!user || user.role !== 'TRADER')
          return { status: 'REJECTED', code: 'TRADER_NOT_FOUND' };
        const now = await databaseTime(tx);
        await tx
          .updateTable('recovery_tokens')
          .set({ revoked_at: now })
          .where('account_id', '=', user.account_id)
          .where('revoked_at', 'is', null)
          .where('used_at', 'is', null)
          .execute();
        const id = randomUUID();
        const secret = newToken();
        const expiresAt = new Date(now.getTime() + RECOVERY_DURATION);
        await tx
          .insertInto('recovery_tokens')
          .values({
            id,
            token_hash: tokenHash(secret)!,
            account_id: user.account_id,
            created_by: principal.accountId,
            expires_at: expiresAt,
            used_at: null,
            revoked_at: null,
          })
          .execute();
        return {
          status: 'ACCEPTED',
          data: { id, accountId: user.account_id, expiresAt: expiresAt.toISOString() },
          token: secret,
        };
      },
    );
  }

  async redeemRecovery(input: { token: string; password: string }): Promise<{ accountId: string }> {
    const hash = tokenHash(input.token);
    if (!hash)
      throw new AuthError(
        'RECOVERY_UNAVAILABLE',
        'The recovery link is invalid, expired, revoked, or already used.',
        400,
      );
    const passwordHash = await hashPassword(input.password);
    return this.exchange.accessTransaction(async (tx, control) => {
      const recovery = await tx
        .selectFrom('recovery_tokens')
        .selectAll()
        .where('token_hash', '=', hash)
        .executeTakeFirst();
      const now = await databaseTime(tx);
      if (!recovery || recovery.revoked_at || recovery.used_at || recovery.expires_at <= now)
        throw new AuthError(
          'RECOVERY_UNAVAILABLE',
          'The recovery link is invalid, expired, revoked, or already used.',
          400,
        );
      const user = await tx
        .selectFrom('users')
        .selectAll()
        .where('account_id', '=', recovery.account_id)
        .executeTakeFirst();
      if (!user || user.role !== 'TRADER')
        throw new AuthError('RECOVERY_UNAVAILABLE', 'The recovery link is unavailable.', 400);
      await tx
        .updateTable('users')
        .set({ password_hash: passwordHash, updated_at: now })
        .where('account_id', '=', user.account_id)
        .execute();
      await tx
        .updateTable('recovery_tokens')
        .set({ used_at: now })
        .where('id', '=', recovery.id)
        .execute();
      await tx
        .updateTable('recovery_tokens')
        .set({ revoked_at: now })
        .where('account_id', '=', user.account_id)
        .where('id', '!=', recovery.id)
        .where('used_at', 'is', null)
        .where('revoked_at', 'is', null)
        .execute();
      await revokeSessions(tx, user.account_id, now);
      await nextSequence(tx, control);
      await appendAudit(tx, {
        actorId: user.account_id,
        commandId: randomUUID(),
        sessionId: control.active_session_id,
        action: 'PASSWORD_RECOVERED',
        targetId: user.account_id,
        reason: 'Trader redeemed a recovery link.',
        result: { status: 'ACCEPTED' },
      });
      return { accountId: user.account_id };
    });
  }
}
