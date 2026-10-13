import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';

describe('invitation and credential lifecycle through HTTP', () => {
  let context: ApiFixture;

  beforeEach(async () => {
    context = await createApiFixture();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  function redeem(token: string, handle = 'trader') {
    return context.client().request('POST', '/api/auth/redeem', {
      token,
      handle,
      password: TEST_PASSWORD,
    });
  }

  it('redeems one invitation atomically under concurrency and stores only hashed credentials', async () => {
    const invitation = await context.invite();
    const results = await Promise.all([
      redeem(invitation.token, 'first_trader'),
      redeem(invitation.token, 'second_trader'),
    ]);
    expect(results.filter((result) => result.statusCode === 200)).toHaveLength(1);
    expect(results.filter((result) => result.statusCode >= 400)).toHaveLength(1);
    const counts = await context.sql.query(`
      SELECT (SELECT count(*)::integer FROM users WHERE role = 'TRADER') AS traders,
        (SELECT count(*)::integer FROM allocations) AS allocations,
        (SELECT count(*)::integer FROM invitations WHERE redeemed_at IS NOT NULL) AS redeemed
    `);
    expect(counts.rows).toEqual([{ traders: 1, allocations: 1, redeemed: 1 }]);
    expect((await context.exchange.reconcile()).ok).toBe(true);

    const stored = await context.sql.query(`
      SELECT 'user' AS kind, row_to_json(users)::text AS record FROM users
      UNION ALL SELECT 'invitation', row_to_json(invitations)::text FROM invitations
      UNION ALL SELECT 'session', row_to_json(login_sessions)::text FROM login_sessions
    `);
    const records = JSON.stringify(stored.rows);
    expect(records).not.toContain(TEST_PASSWORD);
    expect(records).not.toContain(invitation.token);
    expect(records).not.toContain(context.admin.csrfToken);
    expect(records).toContain('$argon2id$');
    expect((await context.admin.request('GET', '/api/admin/invitations')).body).not.toContain(
      invitation.token,
    );
  });

  it('does not consume an invitation when the chosen handle already exists', async () => {
    await context.trader('taken_handle');
    const invitation = await context.invite();
    expect((await redeem(invitation.token, 'taken_handle')).statusCode).toBeGreaterThanOrEqual(400);
    const stored = await context.sql.query<{ redeemed_at: Date | null }>(
      'SELECT redeemed_at FROM invitations WHERE id = $1',
      [invitation.id],
    );
    expect(stored.rows[0]!.redeemed_at).toBeNull();
    expect((await redeem(invitation.token, 'available_handle')).statusCode).toBe(200);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('rejects expired and revoked invitations without issuing funds', async () => {
    const expired = await context.invite();
    await context.sql.query(
      "UPDATE invitations SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1",
      [expired.id],
    );
    expect((await redeem(expired.token)).statusCode).toBeGreaterThanOrEqual(400);
    const revoked = await context.invite();
    const command = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Withdraw the unused invitation',
    };
    const response = await context.admin.request(
      'POST',
      `/api/admin/invitations/${revoked.id}/revoke`,
      command,
    );
    expect(response.statusCode).toBe(200);
    expect((await redeem(revoked.token)).statusCode).toBeGreaterThanOrEqual(400);
    const counts = await context.sql.query('SELECT count(*)::integer AS count FROM allocations');
    expect(counts.rows).toEqual([{ count: 0 }]);
    const listed = (await context.admin.request('GET', '/api/admin/invitations')).body;
    expect(listed).toContain('EXPIRED');
    expect(listed).toContain('REVOKED');
  });

  it('returns invitation handoff secrets only once and binds their retry to the exact command', async () => {
    const command = {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Create a single handoff',
    };
    const first = (await context.admin.request('POST', '/api/admin/invitations', command)).json<{
      token: string;
      data: unknown;
    }>();
    expect(first.token).toBeTruthy();
    const retry = (await context.admin.request('POST', '/api/admin/invitations', command)).json<{
      token?: string;
      data: unknown;
    }>();
    expect(retry.token).toBeUndefined();
    expect(retry.data).toEqual(first.data);
    const changed = await context.admin.request('POST', '/api/admin/invitations', {
      ...command,
      reason: 'Changed intention',
    });
    expect(changed.statusCode).toBe(409);
    const receipt = await context.sql.query('SELECT result FROM receipts WHERE command_id = $1', [
      command.commandId,
    ]);
    expect(JSON.stringify(receipt.rows)).not.toContain(first.token);
    expect(
      JSON.stringify((await context.sql.query('SELECT payload FROM outbox')).rows),
    ).not.toContain(first.token);
    expect((await context.admin.request('GET', '/api/admin/audit')).body).not.toContain(
      first.token,
    );
  });

  it('revokes preceding recovery links and existing sessions and consumes the successful link once', async () => {
    const { browser, user } = await context.trader('trader');
    const issue = () =>
      context.admin.request('POST', `/api/admin/traders/${user.accountId}/recovery`, {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Recover a test account',
      });
    const first = (await issue()).json<{ token: string }>();
    const second = (await issue()).json<{ token: string }>();
    const guest = context.client();
    expect(
      (
        await guest.request('POST', '/api/auth/recover', {
          token: first.token,
          password: 'recovered-test-password',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect(
      (
        await guest.request('POST', '/api/auth/recover', {
          token: second.token,
          password: 'recovered-test-password',
        })
      ).statusCode,
    ).toBe(200);
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect(
      (
        await guest.request('POST', '/api/auth/recover', {
          token: second.token,
          password: 'another-test-password',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    expect((await browser.login('trader')).statusCode).toBe(401);
    expect((await browser.login('trader', 'recovered-test-password')).statusCode).toBe(200);
    const adminSession = (await context.admin.request('GET', '/api/auth/session')).json<{
      user: { accountId: string };
    }>();
    const adminRecovery = await context.admin.request(
      'POST',
      `/api/admin/traders/${adminSession.user.accountId}/recovery`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Must not recover administrator over HTTP',
      },
    );
    expect(
      adminRecovery.statusCode >= 400 ||
        adminRecovery.json<{ status?: string }>().status === 'REJECTED',
    ).toBe(true);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('rejects expired login sessions and recovery links using persisted database time', async () => {
    const { browser, user } = await context.trader('trader');
    const recovery = (
      await context.admin.request('POST', `/api/admin/traders/${user.accountId}/recovery`, {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Exercise recovery expiry',
      })
    ).json<{ token: string; data: { id: string } }>();
    await context.sql.query(
      "UPDATE recovery_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE id = $1",
      [recovery.data.id],
    );
    expect(
      (
        await context.client().request('POST', '/api/auth/recover', {
          token: recovery.token,
          password: 'expired-test-password',
        })
      ).statusCode,
    ).toBeGreaterThanOrEqual(400);
    await context.sql.query(
      "UPDATE login_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' WHERE account_id = $1",
      [user.accountId],
    );
    expect((await browser.request('GET', '/api/me')).statusCode).toBe(401);
    expect((await context.admin.request('GET', '/api/admin/overview')).statusCode).toBe(200);
  });

  it('recovers the owner-only administrator password without creating identities or funds', async () => {
    const administrator = (await context.admin.request('GET', '/api/auth/session')).json<{
      user: { accountId: string; handle: string; role: string };
    }>().user;
    const { browser: trader, user } = await context.trader('existing_trader');
    const before = await context.exchange.snapshot(user.accountId);
    const otherAdmin = context.client();
    expect((await otherAdmin.login('operator')).statusCode).toBe(200);

    await expect(
      context.auth.bootstrapAdmin({ handle: 'another_operator', password: TEST_PASSWORD }),
    ).rejects.toMatchObject({ code: 'ALREADY_INITIALIZED' });
    const replacementPassword = 'replacement-owner-password';
    expect(await context.auth.resetAdminPassword({ password: replacementPassword })).toEqual(
      administrator,
    );

    expect((await context.admin.request('GET', '/api/auth/session')).statusCode).toBe(401);
    expect((await otherAdmin.request('GET', '/api/admin/overview')).statusCode).toBe(401);
    expect((await context.admin.login('operator')).statusCode).toBe(401);
    const recoveredAdmin = context.client();
    const login = await recoveredAdmin.login('operator', replacementPassword);
    expect(login.statusCode).toBe(200);
    expect(login.json<{ user: unknown }>().user).toEqual(administrator);
    expect((await trader.request('GET', '/api/me')).statusCode).toBe(200);

    const history = await recoveredAdmin.request('GET', '/api/admin/audit');
    expect(history.statusCode).toBe(200);
    expect(
      history
        .json<{ action: string; actorId: string; targetId: string; result: unknown }[]>()
        .filter((entry) => entry.action === 'ADMIN_PASSWORD_RESET'),
    ).toEqual([
      expect.objectContaining({
        actorId: administrator.accountId,
        targetId: administrator.accountId,
        result: { status: 'ACCEPTED' },
      }),
    ]);
    expect(history.body).not.toContain(replacementPassword);
    const counts = await context.sql.query(`
      SELECT (SELECT count(*)::integer FROM users WHERE role = 'ADMIN') AS administrators,
        (SELECT count(*)::integer FROM accounts WHERE kind = 'ADMIN') AS administrator_accounts,
        (SELECT count(*)::integer FROM allocations) AS allocations,
        (SELECT count(*)::integer FROM journal_transactions) AS journal_transactions,
        (SELECT count(*)::integer FROM balances JOIN accounts ON accounts.id = balances.account_id
          WHERE accounts.kind = 'ADMIN') AS administrator_balances
    `);
    expect(counts.rows).toEqual([
      {
        administrators: 1,
        administrator_accounts: 1,
        allocations: 1,
        journal_transactions: 1,
        administrator_balances: 0,
      },
    ]);
    expect(await context.exchange.snapshot(user.accountId)).toEqual(before);
  });
});
