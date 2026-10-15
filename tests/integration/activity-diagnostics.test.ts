import { createHash, randomUUID } from 'node:crypto';
import { get, type IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { Diagnostics, type DiagnosticRecord } from '../../apps/server/src/diagnostics.js';
import { HistoryExports } from '../../apps/server/src/history/prepared-export.js';
import { LiveUpdates } from '../../apps/server/src/live.js';
import { DemoMarket } from '../../apps/server/src/demo-market/service.js';
import { DEFAULT_DATABASE_BUDGETS } from '../../packages/database/src/budgets.js';
import type { PreparedHistoryExportView } from '../../packages/contracts/src/index.js';
import { API_ORIGIN, TEST_PASSWORD, createApiFixture, type ApiFixture } from '../helpers/api.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Expected diagnostic lifecycle boundary was not reached.');
}

function recording() {
  const events: DiagnosticRecord[] = [];
  const diagnostics = new Diagnostics({ sink: (event) => events.push(event) });
  return { diagnostics, events };
}

describe('bounded live, export, and simulator diagnostics', () => {
  let context: ApiFixture | undefined;
  const cleanup: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of cleanup.splice(0).reverse()) await close();
    await context?.dispose();
    context = undefined;
  });

  it('records complete export preparation and download outcomes without capabilities or private records', async () => {
    const { diagnostics, events } = recording();
    context = await createApiFixture({ diagnostics });
    const trader = await context.trader('export_trader');
    const another = await context.trader('other_trader');
    const prepared = await trader.browser.request(
      'POST',
      `/api/history/${context.sessionId}/exports`,
      {},
    );
    const bundle = prepared.json<PreparedHistoryExportView>();
    expect(prepared.statusCode).toBe(200);
    expect(diagnostics.snapshot().gauges['export.active_preparations']).toBe(0);
    expect(diagnostics.snapshot().gauges['export.retained_jobs']).toBe(1);
    const file = bundle.files[0]!;
    const origin = await context.listen();
    const downloaded = await fetch(`${origin}${file.downloadUrl}`, {
      headers: { cookie: trader.browser.cookieHeader },
    });
    expect(
      createHash('sha256')
        .update(Buffer.from(await downloaded.arrayBuffer()))
        .digest('hex'),
    ).toBe(file.sha256);
    await until(
      () =>
        diagnostics.snapshot().gauges['export.active_downloads'] === 0 &&
        diagnostics.snapshot().timings['export.download']!.count === 1,
    );
    expect((await another.browser.request('GET', file.downloadUrl)).statusCode).toBe(403);
    expect(diagnostics.snapshot().timings['export.download']!.outcomes).toMatchObject({
      ok: 1,
      rejected: 1,
    });
    expect(diagnostics.snapshot().timings['export.prepare']!.outcomes.ok).toBe(1);
    const serialized = JSON.stringify(events.filter((event) => event.event.startsWith('export.')));
    for (const secret of [
      bundle.exportId,
      trader.user.accountId,
      trader.invitation.token,
      file.sha256,
      file.downloadUrl,
      'manifest.csv',
    ])
      expect(serialized).not.toContain(secret);
    await context.stop();
    expect(diagnostics.snapshot().gauges['export.retained_jobs']).toBe(0);
  });

  it('measures authentication, quota, and timeout failures and releases preparation resources', async () => {
    const { diagnostics } = recording();
    const budgets = structuredClone(DEFAULT_DATABASE_BUDGETS);
    context = await createApiFixture({ diagnostics, database: { budgets } });
    const manager = await HistoryExports.create(context.exchange, { maxConcurrent: 1 });
    cleanup.push(() => manager.close());
    const token = (await context.auth.login({ handle: 'operator', password: TEST_PASSWORD })).token;
    await expect(manager.prepare('private invalid token', context.sessionId)).rejects.toMatchObject(
      { statusCode: 401 },
    );
    const frozen = deferred();
    const release = deferred();
    const resumed = deferred();
    const original = context.exchange.exportReadTransaction.bind(context.exchange);
    context.exchange.exportReadTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        frozen.resolve();
        await release.promise;
        try {
          return await work(tx);
        } finally {
          resumed.resolve();
        }
      });
    budgets.export = { statementMs: 100, totalMs: 300 };
    const pending = manager.prepare(token, context.sessionId);
    const outcome = expect(pending).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    try {
      await frozen.promise;
      expect(diagnostics.snapshot().gauges['export.active_preparations']).toBe(1);
      await expect(manager.prepare(token, context.sessionId)).rejects.toMatchObject({
        code: 'EXPORT_BUSY',
      });
      await outcome;
      expect(diagnostics.snapshot().gauges['export.active_preparations']).toBe(0);
      expect(diagnostics.snapshot().gauges['export.retained_jobs']).toBe(0);
      expect(diagnostics.snapshot().timings['export.prepare']!.outcomes).toMatchObject({
        rejected: 1,
        busy: 1,
        timeout: 1,
      });
    } finally {
      context.exchange.exportReadTransaction = original;
      budgets.export = DEFAULT_DATABASE_BUDGETS.export;
      release.resolve();
      await resumed.promise;
      await pending.catch(() => undefined);
    }
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.prepare(token, context.sessionId, undefined, controller.signal),
    ).rejects.toMatchObject({ code: 'EXPORT_ABORTED' });
    expect(diagnostics.snapshot().timings['export.prepare']!.outcomes.aborted).toBe(1);
    expect(diagnostics.snapshot().gauges['export.active_preparations']).toBe(0);
  });

  it('keeps a download active through real socket backpressure and distinguishes disconnect from deadline', async () => {
    const { diagnostics } = recording();
    context = await createApiFixture({ diagnostics, exports: { downloadMs: 500 } });
    await context.sql.query(
      `
      INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,
        'DIAGNOSTIC_DOWNLOAD','Exercise private download deadlines',jsonb_build_object('note',repeat('x',16000))
      FROM generate_series(1,1000)
    `,
      [context.sessionId],
    );
    const prepared = await context.admin.request(
      'POST',
      `/api/history/${context.sessionId}/exports`,
      {},
    );
    const file = prepared
      .json<PreparedHistoryExportView>()
      .files.find((entry) => entry.name === 'audit.csv')!;
    expect(file.bytes).toBeGreaterThan(8 * 1024 * 1024);
    const origin = await context.listen();
    const pause = async () => {
      const request = get(`${origin}${file.downloadUrl}`, {
        headers: { cookie: context!.admin.cookieHeader },
      });
      const response = await new Promise<IncomingMessage>((resolve, reject) => {
        request.once('error', reject);
        request.once('response', (received) => {
          received.pause();
          received.on('error', () => undefined);
          resolve(received);
        });
      });
      expect(response.statusCode).toBe(200);
      const close = () => {
        response.destroy();
        request.destroy();
      };
      cleanup.push(close);
      return close;
    };
    const abort = await pause();
    await pause();
    expect(diagnostics.snapshot().gauges['export.active_downloads']).toBe(2);
    expect(diagnostics.snapshot().timings['export.download']!.count).toBe(0);
    expect((await context.admin.request('GET', file.downloadUrl)).statusCode).toBe(503);
    abort();
    await until(() => diagnostics.snapshot().timings['export.download']!.outcomes.aborted === 1);
    await until(() => diagnostics.snapshot().gauges['export.active_downloads'] === 0);
    expect(diagnostics.snapshot().timings['export.download']!.outcomes).toMatchObject({
      aborted: 1,
      timeout: 1,
      busy: 1,
    });
    const retry = await context.admin.request('GET', file.downloadUrl);
    expect(createHash('sha256').update(retry.rawPayload).digest('hex')).toBe(file.sha256);
    await until(() => diagnostics.snapshot().timings['export.download']!.outcomes.ok === 1);
    await pause();
    await context.stop();
    await until(() => diagnostics.snapshot().gauges['export.active_downloads'] === 0);
    expect(diagnostics.snapshot().timings['export.download']!.outcomes.aborted).toBe(2);
  });

  it('releases live connection gauges on client disconnect and shutdown and records capacity rejection', async () => {
    const { diagnostics, events } = recording();
    context = await createApiFixture({ diagnostics, live: { pollMs: 20, maxStreams: 1 } });
    const origin = await context.listen();
    const connect = async () => {
      const controller = new AbortController();
      const response = await fetch(
        `${origin}/api/events?sessionId=${context!.sessionId}&cursor=0`,
        {
          headers: { cookie: context!.admin.cookieHeader, origin: API_ORIGIN },
          signal: controller.signal,
        },
      );
      const reader = response.body!.getReader();
      const close = async () => {
        controller.abort();
        await reader.cancel().catch(() => undefined);
      };
      cleanup.push(close);
      expect(response.status).toBe(200);
      expect((await reader.read()).done).toBe(false);
      return close;
    };
    const disconnect = await connect();
    expect(diagnostics.snapshot().gauges['live.connections']).toBe(1);
    const denied = await fetch(`${origin}/api/events?sessionId=${context.sessionId}&cursor=0`, {
      headers: { cookie: context.admin.cookieHeader },
    });
    expect(denied.status).toBe(503);
    await denied.body?.cancel();
    await disconnect();
    await until(() => diagnostics.snapshot().gauges['live.connections'] === 0);
    expect(diagnostics.snapshot().timings['live.connection']!.outcomes).toMatchObject({
      busy: 1,
      aborted: 1,
    });
    await connect();
    await context.stop();
    expect(diagnostics.snapshot().gauges['live.connections']).toBe(0);
    expect(diagnostics.snapshot().timings['live.connection']!.outcomes.unavailable).toBe(1);
    expect(events.filter((event) => event.event === 'live.connected')).toHaveLength(2);
    expect(events.filter((event) => event.event === 'live.frame').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(events.filter((event) => event.event.startsWith('live.')))).not.toContain(
      'cursor',
    );
  });

  it('reports live frame backpressure once without retaining a queue or frame payload', async () => {
    const { diagnostics, events } = recording();
    context = await createApiFixture({ diagnostics });
    const token = (await context.auth.login({ handle: 'operator', password: TEST_PASSWORD })).token;
    const live = new LiveUpdates(context.exchange, { pollMs: 20 });
    cleanup.push(() => live.close());
    const emitter = new EventEmitter();
    const raw = Object.assign(emitter, {
      setHeader: () => undefined,
      writeHead: () => undefined,
      flushHeaders: () => undefined,
      write: () => false,
      end: () => undefined,
      destroy: () => emitter.emit('close'),
    });
    const reply = {
      raw,
      hijack: () => undefined,
      getHeaders: () => ({}),
    } as unknown as Parameters<LiveUpdates['connect']>[0];
    await live.connect(reply, token, context.sessionId, '0');
    await until(() => diagnostics.snapshot().timings['live.connection']!.outcomes.busy === 1);
    expect(diagnostics.snapshot().gauges['live.connections']).toBe(0);
    expect(events.filter((event) => event.event === 'live.disconnected')).toHaveLength(1);
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'live.frame', outcome: 'busy' }),
    );
    expect(JSON.stringify(events)).not.toContain(token);
  });

  it('records one simulator cycle for coalesced callers, then a skipped paused attempt without reallocating', async () => {
    const { diagnostics, events } = recording();
    context = await createApiFixture({ diagnostics });
    const simulator = new DemoMarket(context.exchange);
    cleanup.push(() => simulator.close());
    await context.admin.request('POST', '/api/admin/simulator/start', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Exercise observed simulator lifecycle',
    });
    await context.marketState('resume');
    const first = simulator.tick();
    const second = simulator.tick();
    expect(first).toBe(second);
    expect(diagnostics.snapshot().gauges['simulator.in_flight']).toBe(1);
    await Promise.all([first, second]);
    expect(diagnostics.snapshot().timings['simulator.cycle']!.count).toBe(1);
    expect(diagnostics.snapshot().timings['simulator.cycle']!.outcomes.ok).toBe(1);
    expect(diagnostics.snapshot().gauges['simulator.in_flight']).toBe(0);
    expect((await context.sql.query('SELECT cycle FROM demo_market')).rows).toEqual([
      { cycle: '1' },
    ]);
    await context.marketState('pause');
    await simulator.tick();
    expect(diagnostics.snapshot().timings['simulator.cycle']!.outcomes.skipped).toBe(1);
    expect(events.filter((event) => event.event === 'simulator.cycle')).toHaveLength(2);
    expect(
      (await context.sql.query('SELECT count(*)::integer AS count FROM allocations')).rows,
    ).toEqual([{ count: 2 }]);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('releases the simulator gauge after failure and resumes its original durable plan', async () => {
    const { diagnostics, events } = recording();
    let fail = true;
    context = await createApiFixture({
      diagnostics,
      hooks: {
        beforeCommit: async () => {
          if (fail) {
            fail = false;
            throw new Error('private simulator token');
          }
        },
      },
    });
    const simulator = new DemoMarket(context.exchange);
    cleanup.push(() => simulator.close());
    await context.admin.request('POST', '/api/admin/simulator/start', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Exercise original simulator plan recovery',
    });
    await context.marketState('resume');
    await expect(simulator.tick()).rejects.toThrow('private simulator token');
    expect(diagnostics.snapshot().timings['simulator.cycle']!.outcomes.error).toBe(1);
    expect(diagnostics.snapshot().gauges['simulator.in_flight']).toBe(0);
    await simulator.tick();
    expect(diagnostics.snapshot().timings['simulator.cycle']!.outcomes.ok).toBe(1);
    expect(
      (await context.sql.query('SELECT count(*)::integer AS count FROM allocations')).rows,
    ).toEqual([{ count: 2 }]);
    expect(JSON.stringify(events)).not.toContain('private simulator token');
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});
