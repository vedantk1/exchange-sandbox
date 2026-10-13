import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceView } from '../../packages/contracts/src/index.js';
import { API_ORIGIN, createApiFixture, type ApiClient, type ApiFixture } from '../helpers/api.js';

interface Frame {
  event: string;
  id?: string;
  data: Record<string, unknown>;
}

async function stream(
  origin: string,
  browser: ApiClient,
  sessionId: string,
  cursor: string,
  headers: Record<string, string> = {},
) {
  const controller = new AbortController();
  const response = await fetch(`${origin}/api/events?sessionId=${sessionId}&cursor=${cursor}`, {
    headers: { cookie: browser.cookieHeader, origin: API_ORIGIN, ...headers },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return {
    status: response.status,
    async next(event?: string): Promise<Frame | undefined> {
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        while (true) {
          const end = buffered.indexOf('\n\n');
          if (end >= 0) {
            const text = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            const lines = Object.fromEntries(
              text.split('\n').map((line) => {
                const colon = line.indexOf(':');
                return [line.slice(0, colon), line.slice(colon + 1).trim()];
              }),
            );
            const frame: Frame = {
              event: lines.event!,
              ...(lines.id ? { id: lines.id } : {}),
              data: JSON.parse(lines.data!),
            };
            if (!event || event === frame.event) return frame;
          } else {
            const chunk = await reader.read();
            if (chunk.done) return undefined;
            buffered += decoder.decode(chunk.value, { stream: true });
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
  };
}

describe('authenticated live invalidation over real HTTP sockets', () => {
  let context: ApiFixture;
  let origin: string;
  const streams: Awaited<ReturnType<typeof stream>>[] = [];
  beforeEach(async () => {
    context = await createApiFixture({
      live: { pollMs: 30, heartbeatMs: 120, maxStreams: 4, maxStreamsPerAccount: 2 },
      admission: { maxActiveRequests: 1 },
    });
    origin = await context.listen();
  });
  afterEach(async () => {
    await Promise.all(streams.splice(0).map((item) => item.close()));
    await context?.dispose();
  });
  async function connect(
    browser: ApiClient,
    cursor: string,
    sessionId = context.sessionId,
    headers: Record<string, string> = {},
  ) {
    const item = await stream(origin, browser, sessionId, cursor, headers);
    streams.push(item);
    return item;
  }
  async function cursor(browser: ApiClient) {
    return (await browser.request('GET', '/api/workspace')).json<WorkspaceView>().cursor;
  }

  it('catches up from the snapshot cursor, reports live commits and keeps ordinary request slots free', async () => {
    const trader = await context.trader('trader');
    const start = await cursor(trader.browser);
    await context.marketState('resume');
    const live = await connect(trader.browser, start);
    expect(live.status).toBe(200);
    const catchup = await live.next('invalidate');
    expect(BigInt(catchup!.id!)).toBeGreaterThan(BigInt(start));
    // maxActiveRequests=1: retaining that admission slot would reject this order.
    const result = await trader.browser.request('POST', '/api/orders', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '50000',
    });
    expect(result.statusCode).toBe(200);
    const update = await live.next('invalidate');
    expect(BigInt(update!.id!)).toBeGreaterThan(BigInt(catchup!.id!));
    expect(update!.data).toEqual({ sessionId: context.sessionId, cursor: update!.id });
    expect(JSON.stringify(update)).not.toContain(trader.user.accountId);
    expect(JSON.stringify(update)).not.toContain(result.json<{ order: { id: string } }>().order.id);
    expect((await live.next('heartbeat'))?.id).toBe(update!.id);
  });

  it('filters unrelated administrative activity and advances harmless cursor gaps through heartbeats', async () => {
    const trader = await context.trader('trader');
    const live = await connect(trader.browser, await cursor(trader.browser));
    expect((await live.next())?.event).toBe('ready');
    const invitation = await context.invite();
    const heartbeat = await live.next();
    expect(heartbeat?.event).toBe('heartbeat');
    expect(JSON.stringify(heartbeat)).not.toContain(invitation.token);
    expect(JSON.stringify(heartbeat)).not.toContain(invitation.id);
    const operator = await connect(context.admin, heartbeat!.id!);
    expect((await operator.next())?.event).toBe('ready');
    await context.invite();
    expect((await operator.next('invalidate'))?.event).toBe('invalidate');
  });

  it('forces snapshot reset for unknown/ahead/session cursors and honors Last-Event-ID on reconnect', async () => {
    const trader = await context.trader('trader');
    const current = await cursor(trader.browser);
    const ahead = await connect(trader.browser, '999999999');
    expect((await ahead.next())?.event).toBe('reset');
    await ahead.close();
    const other = await connect(trader.browser, current, randomUUID());
    expect((await other.next())?.event).toBe('reset');
    await other.close();
    await context.marketState('resume');
    const reconnect = await connect(trader.browser, '999999999', context.sessionId, {
      'last-event-id': current,
    });
    expect((await reconnect.next())?.event).toBe('invalidate');
  });

  it('closes a stream after logout before delivering further events and denies revoked replay', async () => {
    const trader = await context.trader('trader');
    const current = await cursor(trader.browser);
    const live = await connect(trader.browser, current);
    expect((await live.next())?.event).toBe('ready');
    const oldCookie = trader.browser.cookieHeader;
    await trader.browser.request('POST', '/api/auth/logout', {});
    expect((await live.next('auth-lost'))?.data).toEqual({});
    expect(await live.next()).toBeUndefined();
    const denied = await fetch(
      `${origin}/api/events?sessionId=${context.sessionId}&cursor=${current}`,
      { headers: { cookie: oldCookie } },
    );
    expect(denied.status).toBe(401);
    await denied.body?.cancel();
  });

  it('bounds stream count, detects access suspension, and closes streams during server shutdown', async () => {
    const trader = await context.trader('trader');
    const current = await cursor(trader.browser);
    const first = await connect(trader.browser, current);
    await first.next();
    const second = await connect(trader.browser, current);
    await second.next();
    const denied = await fetch(
      `${origin}/api/events?sessionId=${context.sessionId}&cursor=${current}`,
      { headers: { cookie: trader.browser.cookieHeader } },
    );
    expect(denied.status).toBe(503);
    expect(((await denied.json()) as { code: string }).code).toBe('STREAM_LIMIT');
    await context.admin.request('POST', `/api/admin/traders/${trader.user.accountId}/suspend`, {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Exercise live session revocation',
    });
    expect((await first.next('auth-lost'))?.event).toBe('auth-lost');
    expect((await second.next('auth-lost'))?.event).toBe('auth-lost');
    const operator = await connect(context.admin, await cursor(context.admin));
    await operator.next();
    await context.stop();
    expect(await operator.next()).toBeUndefined();
  });

  it('invalidates a newly faulted market even when the durable outbox cursor is unchanged', async () => {
    const trader = await context.trader('trader');
    const current = await cursor(trader.browser);
    const live = await connect(trader.browser, current);
    await live.next();
    await context.sql.query('UPDATE exchange_control SET fault = $1 WHERE id = 1', [
      'Injected owner-only inspection fault',
    ]);
    const update = await live.next('invalidate');
    expect(update?.id).toBe(current);
    const workspace = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
    expect(workspace.fault).toBe('ACCOUNTING_FAULT');
    expect(workspace.cursor).toBe(current);
  });

  it('removes recovery-revoked and expired sessions from live delivery', async () => {
    const trader = await context.trader('trader');
    const live = await connect(trader.browser, await cursor(trader.browser));
    await live.next();
    const recovery = await context.admin.request(
      'POST',
      `/api/admin/traders/${trader.user.accountId}/recovery`,
      {
        commandId: randomUUID(),
        sessionId: context.sessionId,
        reason: 'Exercise password recovery revocation',
      },
    );
    expect(
      (
        await context.client().request('POST', '/api/auth/recover', {
          token: recovery.json<{ token: string }>().token,
          password: 'replacement-test-password',
        })
      ).statusCode,
    ).toBe(200);
    expect((await live.next('auth-lost'))?.event).toBe('auth-lost');
    expect((await trader.browser.login('trader', 'replacement-test-password')).statusCode).toBe(
      200,
    );
    const fresh = await connect(trader.browser, await cursor(trader.browser));
    await fresh.next();
    await context.sql.query(
      "UPDATE login_sessions SET created_at = clock_timestamp() - interval '1 hour', expires_at = clock_timestamp() - interval '1 second' WHERE account_id = $1 AND revoked_at IS NULL",
      [trader.user.accountId],
    );
    expect((await fresh.next('auth-lost'))?.event).toBe('auth-lost');
  });

  it('rejects foreign origins and malformed cursors before opening a stream', async () => {
    const trader = await context.trader('trader');
    const path = `${origin}/api/events?sessionId=${context.sessionId}&cursor=0`;
    for (const headers of [
      { origin: 'https://foreign.invalid' },
      { 'sec-fetch-site': 'cross-site' },
      { 'last-event-id': '1\u0009wrong' },
    ]) {
      const response = await fetch(path, {
        headers: { cookie: trader.browser.cookieHeader, ...headers },
      });
      expect(response.status).toBe(headers['last-event-id'] ? 400 : 403);
      await response.body?.cancel();
    }
    const response = await fetch(`${origin}/api/events?sessionId=${context.sessionId}&cursor=-1`, {
      headers: { cookie: trader.browser.cookieHeader },
    });
    expect(response.status).toBe(400);
    await response.body?.cancel();
  });
});
