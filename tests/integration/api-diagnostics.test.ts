import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  Diagnostics,
  type DiagnosticRecord,
  type DiagnosticsSnapshot,
} from '../../apps/server/src/diagnostics.js';
import { DEFAULT_DATABASE_BUDGETS } from '../../packages/database/src/index.js';
import type { CommandResult } from '../../apps/server/src/types.js';
import { createApiFixture, TEST_PASSWORD, type ApiFixture } from '../helpers/api.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('private operational diagnostics through HTTP', () => {
  let context: ApiFixture;
  let records: DiagnosticRecord[];
  let diagnostics: Diagnostics;

  async function open(options: Parameters<typeof createApiFixture>[0] = {}) {
    records = [];
    diagnostics = new Diagnostics({ sink: (record) => records.push(record) });
    context = await createApiFixture({ ...options, diagnostics });
    return context;
  }

  afterEach(async () => context?.dispose());

  function order() {
    return {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '50000',
    };
  }

  async function waitForControlLock(holder: number) {
    await expect
      .poll(async () => {
        const result = await context.sql.query<{ waiting: boolean }>(
          `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock' AND query ILIKE '%exchange_control%'
        ) AS waiting`,
          [holder],
        );
        return result.rows[0]!.waiting;
      })
      .toBe(true);
  }

  it('requires an administrator and returns only a no-store aggregate snapshot', async () => {
    await open();
    const { browser, user, invitation } = await context.trader('diagnostics_trader');
    await context.marketState('resume');
    const submission = order();
    const placed = await browser.request('POST', '/api/orders', submission);
    expect(placed.statusCode).toBe(200);
    const result = placed.json<CommandResult>();

    const anonymous = await context.client().request('GET', '/api/admin/diagnostics');
    const forbidden = await browser.request('GET', '/api/admin/diagnostics');
    const allowed = await context.admin.request('GET', '/api/admin/diagnostics');
    expect(anonymous.statusCode).toBe(401);
    expect(forbidden.statusCode).toBe(403);
    expect(allowed.statusCode).toBe(200);
    for (const response of [anonymous, forbidden, allowed]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-request-id']).toMatch(uuid);
    }
    const snapshot = allowed.json<DiagnosticsSnapshot>();
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      histogramSemantics: 'cumulative',
      process: { rssBytes: expect.any(Number), heapUsedBytes: expect.any(Number) },
      timings: { 'engine.command': { outcomes: { accepted: 1 } } },
    });
    expect(Object.keys(snapshot).sort()).toEqual([
      'events',
      'gauges',
      'generatedAt',
      'histogramSemantics',
      'process',
      'schemaVersion',
      'startedAt',
      'timings',
      'uptimeSeconds',
    ]);
    for (const secret of [
      user.accountId,
      user.handle,
      invitation.id,
      invitation.token,
      submission.commandId,
      context.sessionId,
      result.order!.id,
      TEST_PASSWORD,
      browser.cookieHeader,
      browser.csrfToken,
      context.admin.cookieHeader,
      context.admin.csrfToken,
      context.url,
    ])
      expect(allowed.body).not.toContain(secret);
    expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(0);
  });

  it('correlates committed commands and retries with distinct server-generated request identities', async () => {
    await open();
    const { browser, user } = await context.trader('correlation_trader');
    await context.marketState('resume');
    records.length = 0;
    const submission = order();
    const callerRequestId = randomUUID();
    const first = await browser.request('POST', '/api/orders', submission, {
      'x-request-id': callerRequestId,
    });
    const replay = await browser.request('POST', '/api/orders', submission, {
      'x-request-id': callerRequestId,
    });
    expect(first.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());
    const original = first.json<CommandResult>();
    const firstId = first.headers['x-request-id'];
    const retryId = replay.headers['x-request-id'];
    expect(firstId).toMatch(uuid);
    expect(retryId).toMatch(uuid);
    expect(firstId).not.toBe(callerRequestId);
    expect(retryId).not.toBe(callerRequestId);
    expect(retryId).not.toBe(firstId);

    const commands = records.filter((record) => record.event === 'command.completed');
    expect(commands).toHaveLength(2);
    expect(commands).toEqual([
      expect.objectContaining({
        requestId: firstId,
        commandId: submission.commandId,
        sessionId: context.sessionId,
        sequence: original.sequence,
        operation: 'limit_order',
        outcome: 'accepted',
      }),
      expect.objectContaining({
        requestId: retryId,
        commandId: submission.commandId,
        sessionId: context.sessionId,
        sequence: original.sequence,
        operation: 'limit_order',
        outcome: 'accepted',
      }),
    ]);
    expect(records.filter((record) => record.event === 'command.replayed')).toEqual([
      expect.objectContaining({
        requestId: retryId,
        commandId: submission.commandId,
        sessionId: context.sessionId,
        sequence: original.sequence,
      }),
    ]);
    for (const requestId of [firstId, retryId]) {
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'request.completed',
          requestId,
          commandId: submission.commandId,
          sessionId: context.sessionId,
          statusCode: 200,
        }),
      );
    }
    expect(JSON.stringify(records)).not.toContain(user.accountId);
    expect(JSON.stringify(records)).not.toContain(callerRequestId);
    expect((await context.exchange.snapshot(user.accountId)).orders).toHaveLength(1);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('counts saturated and expired admission separately and releases capacity without financial effects', async () => {
    const admission = { maxActiveRequests: 1, deadlineMs: 8_000 };
    await open({ admission });
    const { browser, user } = await context.trader('admission_trader');
    await context.marketState('resume');
    admission.deadlineMs = 500;
    await context.start();
    records.length = 0;
    const submission = order();
    const holder = await context.sql.connect();
    await holder.query('BEGIN');
    const pid = (await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    await holder.query('SELECT id FROM exchange_control WHERE id = 1 FOR UPDATE');
    let pending: ReturnType<typeof browser.request> | undefined;
    try {
      pending = browser.request('POST', '/api/orders', submission);
      await waitForControlLock(pid);
      expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(1);
      const busy = await context.client().request('GET', '/health/live');
      expect(busy.statusCode).toBe(503);
      expect(busy.json()).toMatchObject({ code: 'ADMISSION_BUSY' });
      expect(busy.headers['x-request-id']).toMatch(uuid);
      expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await holder.query('COMMIT');
      const expired = await pending;
      expect(expired.statusCode).toBe(503);
      expect(expired.json()).toMatchObject({ code: 'ADMISSION_EXPIRED' });
      expect(records.filter((record) => record.event === 'admission.rejected')).toEqual([
        expect.objectContaining({ requestId: busy.headers['x-request-id'], outcome: 'busy' }),
        expect.objectContaining({ requestId: expired.headers['x-request-id'], outcome: 'timeout' }),
      ]);
      expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(0);
      expect(await context.exchange.getReceipt(user.accountId, submission.commandId)).toBeNull();
      expect((await context.exchange.snapshot(user.accountId)).orders).toEqual([]);
      expect((await context.exchange.snapshot(user.accountId)).balances['BTC-SIM'].reserved).toBe(
        '0.0000',
      );
      expect(context.exchange.getRuntimeFault()).toBeNull();
      expect((await context.client().request('GET', '/health/live')).statusCode).toBe(200);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  });

  it('reports a canceled SQL statement as a recoverable timeout and preserves original command retry', async () => {
    const budgets = structuredClone(DEFAULT_DATABASE_BUDGETS);
    await open({ database: { budgets } });
    const { browser, user } = await context.trader('timeout_trader');
    await context.marketState('resume');
    const before = await context.exchange.snapshot(user.accountId);
    const submission = order();
    await context.sql.query(`
      CREATE FUNCTION diagnostics_slow_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(2); RETURN NEW; END; $$;
      CREATE TRIGGER diagnostics_slow_insert BEFORE INSERT ON orders
      FOR EACH ROW EXECUTE FUNCTION diagnostics_slow_insert();
    `);
    budgets.command = { statementMs: 150, totalMs: 1_000 };
    records.length = 0;
    const timeoutsBefore =
      diagnostics.snapshot().timings['database.command.query'].outcomes.timeout;
    try {
      const response = await browser.request('POST', '/api/orders', submission);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'DATABASE_TIMEOUT' });
      expect(diagnostics.snapshot().timings['database.command.query'].outcomes.timeout).toBe(
        timeoutsBefore + 1,
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'command.completed',
          requestId: response.headers['x-request-id'],
          commandId: submission.commandId,
          sessionId: context.sessionId,
          outcome: 'timeout',
        }),
      );
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'request.completed',
          requestId: response.headers['x-request-id'],
          statusCode: 503,
          outcome: 'timeout',
        }),
      );
      expect(await context.exchange.getReceipt(user.accountId, submission.commandId)).toBeNull();
      expect(await context.exchange.snapshot(user.accountId)).toEqual(before);
      expect(context.exchange.getRuntimeFault()).toBeNull();
      expect(JSON.stringify(records)).not.toContain('diagnostics_slow_insert');
    } finally {
      budgets.command = DEFAULT_DATABASE_BUDGETS.command;
      await context.sql.query('DROP TRIGGER diagnostics_slow_insert ON orders');
    }
    const accepted = await browser.request('POST', '/api/orders', submission);
    expect(accepted.json()).toMatchObject({ status: 'ACCEPTED', order: { status: 'OPEN' } });
    expect((await browser.request('POST', '/api/orders', submission)).json()).toEqual(
      accepted.json(),
    );
    expect((await context.exchange.snapshot(user.accountId)).orders).toHaveLength(1);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('omits invalid payloads, raw URLs, credentials, headers, and tokens from emitted records', async () => {
    await open();
    const password = 'private-diagnostics-password';
    const token = 'private-diagnostics-token';
    const rawIdentity = 'private-invalid-command-identity';
    const rawPath = 'private-diagnostics-path';
    records.length = 0;
    const invalid = await context.admin.request(
      'POST',
      `/api/orders?token=${token}`,
      {
        ...order(),
        commandId: rawIdentity,
        password,
        token,
      },
      { authorization: `Bearer ${token}`, 'x-request-id': token },
    );
    const failedLogin = await context
      .client()
      .request('POST', `/api/auth/login?password=${password}`, {
        handle: 'operator',
        password,
      });
    const missing = await context.client().request('GET', `/api/${rawPath}?token=${token}`);
    expect(invalid.statusCode).toBe(400);
    expect(failedLogin.statusCode).toBe(401);
    expect(missing.statusCode).toBe(404);
    for (const response of [invalid, failedLogin, missing]) {
      expect(response.headers['x-request-id']).toMatch(uuid);
      expect(records).toContainEqual(
        expect.objectContaining({
          event: 'request.completed',
          requestId: response.headers['x-request-id'],
          statusCode: response.statusCode,
        }),
      );
    }
    const serialized = JSON.stringify({ records, snapshot: diagnostics.snapshot() });
    for (const secret of [
      password,
      token,
      rawIdentity,
      rawPath,
      TEST_PASSWORD,
      context.admin.cookieHeader,
      context.admin.csrfToken,
      context.url,
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/authorization|password_hash|token_hash|csrf_hash/);
    expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(0);
  });

  it('remains inspectable while faulted and still performs authoritative authentication reads', async () => {
    const budgets = structuredClone(DEFAULT_DATABASE_BUDGETS);
    await open({ database: { budgets } });
    const privateDiagnostic = 'private invariant diagnostic that must stay out of telemetry';
    await expect(
      context.exchange.financialTransaction(async () => {
        throw Object.assign(new Error(privateDiagnostic), { code: '23514' });
      }),
    ).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    const faulted = await context.admin.request('GET', '/api/admin/diagnostics');
    expect(faulted.statusCode).toBe(200);
    expect(faulted.json<DiagnosticsSnapshot>().gauges['engine.faulted']).toBe(1);
    expect(faulted.body).not.toContain(privateDiagnostic);

    const blocker = await context.sql.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE login_sessions IN ACCESS EXCLUSIVE MODE');
    budgets.read = { statementMs: 150, totalMs: 1_000 };
    try {
      const unavailable = await context.admin.request('GET', '/api/admin/diagnostics');
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toMatchObject({ code: 'DATABASE_TIMEOUT' });
      expect(
        diagnostics.snapshot().timings['database.read.query'].outcomes.timeout,
      ).toBeGreaterThan(0);
    } finally {
      budgets.read = DEFAULT_DATABASE_BUDGETS.read;
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect((await context.admin.request('GET', '/api/admin/diagnostics')).statusCode).toBe(200);
    await context.sql.query(`UPDATE login_sessions SET revoked_at = clock_timestamp()
      WHERE account_id IN (SELECT account_id FROM users WHERE role = 'ADMIN')`);
    expect((await context.admin.request('GET', '/api/admin/diagnostics')).statusCode).toBe(401);
    expect((await context.client().request('GET', '/api/admin/diagnostics')).statusCode).toBe(401);
    expect(JSON.stringify(records)).not.toContain(privateDiagnostic);
    expect(diagnostics.snapshot().gauges['http.active_requests']).toBe(0);
  });
});
