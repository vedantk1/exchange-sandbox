import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { API_ORIGIN, createApiFixture, type ApiClient, type ApiFixture } from '../helpers/api.js';

describe('HTTP admission and observed client disconnects', () => {
  let context: ApiFixture;

  afterEach(async () => {
    await context?.dispose();
  });

  async function waitUntil<T>(read: () => Promise<T | undefined>): Promise<T> {
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const result = await read();
      if (result !== undefined) return result;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('The expected database/request boundary was not reached.');
  }

  async function holdControl() {
    const connection = await context.sql.connect();
    await connection.query('BEGIN');
    const holder = await connection.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    await connection.query('SELECT id FROM exchange_control WHERE id = 1 FOR UPDATE');
    return { connection, pid: holder.rows[0]!.pid };
  }

  async function waiterPid(holder: number) {
    return waitUntil(async () => {
      const result = await context.sql.query<{ pid: number }>(
        `
        SELECT pid FROM pg_stat_activity
        WHERE $1 = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock' AND query ILIKE '%exchange_control%'
      `,
        [holder],
      );
      return result.rows[0]?.pid;
    });
  }

  async function waitForIdle(pid: number) {
    await waitUntil(async () => {
      const result = await context.sql.query<{ state: string; xact_start: Date | null }>(
        'SELECT state, xact_start FROM pg_stat_activity WHERE pid = $1',
        [pid],
      );
      const row = result.rows[0];
      return !row || (row.state === 'idle' && row.xact_start === null) ? true : undefined;
    });
  }

  async function release(connection: PoolClient) {
    await connection.query('ROLLBACK');
    connection.release();
  }

  function command() {
    return {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '50000',
    };
  }

  function realRequest(origin: string, browser: ApiClient, body: object) {
    const controller = new AbortController();
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    // Observe the server's response close, rather than assuming that a local
    // fetch rejection means the disconnect has reached the server already.
    context.httpServer.once('request', (_request, response) =>
      response.once('close', resolveClosed),
    );
    const outcome = fetch(`${origin}/api/orders`, {
      method: 'POST',
      headers: {
        origin: API_ORIGIN,
        cookie: browser.cookieHeader,
        'x-csrf-token': browser.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }).then(
      (response) => ({ response, error: undefined }),
      (error: unknown) => ({ response: undefined, error }),
    );
    return { controller, closed, outcome };
  }

  async function expectNoEffects(accountId: string, commandId: string) {
    expect(
      (await context.sql.query('SELECT id FROM orders WHERE account_id = $1', [accountId])).rows,
    ).toEqual([]);
    expect(
      (
        await context.sql.query(
          'SELECT command_id FROM receipts WHERE actor_id = $1 AND command_id = $2',
          [accountId, commandId],
        )
      ).rows,
    ).toEqual([]);
    expect((await context.sql.query('SELECT fault FROM exchange_control')).rows).toEqual([
      { fault: null },
    ]);
    expect((await context.exchange.snapshot(accountId)).balances['BTC-SIM'].reserved).toBe(
      '0.0000',
    );
  }

  it('cancels an observed disconnect before admission and retains its capacity slot until queued work settles', async () => {
    context = await createApiFixture({ admission: { maxActiveRequests: 1 } });
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const origin = await context.listen();
    const held = await holdControl();
    const submission = command();
    const request = realRequest(origin, browser, submission);
    try {
      const waiter = await waiterPid(held.pid);
      request.controller.abort();
      await request.closed;
      expect((await request.outcome).error).toBeTruthy();
      const overloaded = await context.client().request('GET', '/health/live');
      expect(overloaded.statusCode).toBe(503);
      expect(overloaded.json()).toMatchObject({ code: 'ADMISSION_BUSY' });
      await held.connection.query('COMMIT');
      await waitForIdle(waiter);
      await waitUntil(async () =>
        (await context.client().request('GET', '/health/live')).statusCode === 200
          ? true
          : undefined,
      );
      await expectNoEffects(user.accountId, submission.commandId);
    } finally {
      request.controller.abort();
      await release(held.connection);
      await request.outcome;
    }
  });

  it('times out a busy control lock without financial effects and permits the original command to retry', async () => {
    context = await createApiFixture();
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const held = await holdControl();
    const submission = command();
    try {
      const request = browser.request('POST', '/api/orders', submission);
      await waiterPid(held.pid);
      const response = await request;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'ADMISSION_BUSY' });
      await held.connection.query('COMMIT');
      await expectNoEffects(user.accountId, submission.commandId);
      const retried = await browser.request('POST', '/api/orders', submission);
      expect(retried.json()).toMatchObject({ status: 'ACCEPTED', order: { status: 'OPEN' } });
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      await release(held.connection);
    }
  });

  it('checks its deadline after waiting for the lock before admitting a command', async () => {
    const admission = { deadlineMs: 8_000 };
    context = await createApiFixture({ admission });
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    // Account setup uses the ordinary hash/deadline budget even on slow CI.
    // The short deadline applies only to the deliberate queued-command probe.
    admission.deadlineMs = 500;
    await context.start();
    const held = await holdControl();
    const submission = command();
    let request: ReturnType<typeof browser.request> | undefined;
    try {
      request = browser.request('POST', '/api/orders', submission);
      await waiterPid(held.pid);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await held.connection.query('COMMIT');
      const response = await request;
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'ADMISSION_EXPIRED' });
      await expectNoEffects(user.accountId, submission.commandId);
    } finally {
      await release(held.connection);
      await request;
    }
  });

  it('commits an already admitted command after disconnect and resolves it through its original receipt', async () => {
    const commandId = randomUUID();
    let resolveAdmitted!: () => void;
    let continueCommand!: () => void;
    const admitted = new Promise<void>((resolve) => {
      resolveAdmitted = resolve;
    });
    const continuation = new Promise<void>((resolve) => {
      continueCommand = resolve;
    });
    context = await createApiFixture({
      hooks: {
        beforeCommit: async (id) => {
          if (id === commandId) {
            resolveAdmitted();
            await continuation;
          }
        },
      },
    });
    const { browser, user } = await context.trader('trader');
    await context.marketState('resume');
    const origin = await context.listen();
    const submission = { ...command(), commandId };
    const request = realRequest(origin, browser, submission);
    try {
      await admitted;
      request.controller.abort();
      await request.closed;
      expect((await request.outcome).error).toBeTruthy();
      continueCommand();
      const receipt = await waitUntil(
        async () => (await context.exchange.getReceipt(user.accountId, commandId)) ?? undefined,
      );
      expect(receipt).toMatchObject({ status: 'ACCEPTED', order: { status: 'OPEN' } });
      expect((await browser.request('POST', '/api/orders', submission)).json()).toEqual(receipt);
      expect((await context.exchange.snapshot(user.accountId)).orders).toHaveLength(1);
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      continueCommand();
      request.controller.abort();
      await request.outcome;
    }
  });
});
