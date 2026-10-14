import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { get, type IncomingMessage } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_DATABASE_BUDGETS } from '../../packages/database/src/budgets.js';
import type {
  HistoryExportView,
  PreparedHistoryExportView,
} from '../../packages/contracts/src/index.js';
import { API_ORIGIN, createApiFixture, type ApiClient, type ApiFixture } from '../helpers/api.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function csvRows(text: string): Record<string, string>[] {
  const cells = [...text.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n)/g)].map((match) =>
    match[1]!.replaceAll('""', '"'),
  );
  const columns = cells.splice(0, text.slice(0, text.indexOf('\r\n')).split(',').length);
  const rows: Record<string, string>[] = [];
  for (let offset = 0; offset < cells.length; offset += columns.length)
    rows.push(Object.fromEntries(columns.map((column, index) => [column, cells[offset + index]!])));
  return rows;
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error('Expected export lifecycle boundary was not reached.');
}

describe('bounded complete history downloads', () => {
  let context: ApiFixture | undefined;
  let directory = '';
  afterEach(async () => {
    await context?.dispose();
    context = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = '';
  });

  async function fixture(options: Parameters<typeof createApiFixture>[0] = {}) {
    directory = await mkdtemp('.local/history-export-test-');
    context = await createApiFixture({ ...options, exports: { directory, ...options.exports } });
    return context;
  }

  async function prepare(
    browser: ApiClient,
    accountId?: string,
  ): Promise<PreparedHistoryExportView> {
    const response = await browser.request(
      'POST',
      `/api/history/${context!.sessionId}/exports`,
      accountId ? { accountId } : {},
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).not.toHaveProperty('content');
    return response.json<PreparedHistoryExportView>();
  }

  async function contents(browser: ApiClient, bundle: PreparedHistoryExportView) {
    const files = new Map<string, string>();
    for (const file of bundle.files) {
      const response = await browser.request('GET', file.downloadUrl);
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(`attachment; filename="${file.name}"`);
      expect(response.headers['content-length']).toBe(String(file.bytes));
      expect(Buffer.byteLength(response.body)).toBe(file.bytes);
      expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(file.sha256);
      expect(csvRows(response.body)).toHaveLength(file.rows);
      files.set(file.name, response.body);
    }
    return files;
  }

  async function largeAuditFile(app: ApiFixture) {
    await app.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'SLOW_EXPORT','Exercise download resource limits',jsonb_build_object('note',repeat('x',16000)) FROM generate_series(1,1000)`,
      [app.sessionId],
    );
    const bundle = await prepare(app.admin);
    const file = bundle.files.find((entry) => entry.name === 'audit.csv')!;
    expect(file.bytes).toBeGreaterThan(8 * 1024 * 1024);
    return { bundle, file };
  }

  async function pausedDownload(app: ApiFixture, origin: string, url: string) {
    const closed = deferred();
    let serverClosed = false;
    let finished = false;
    app.httpServer.once('request', (_request, response) => {
      response.once('finish', () => {
        finished = true;
      });
      response.once('close', () => {
        serverClosed = true;
        closed.resolve();
      });
    });
    const request = get(`${origin}${url}`, { headers: { cookie: app.admin.cookieHeader } });
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      request.once('error', reject);
      request.once('response', (received) => {
        // Pausing a body larger than the socket buffers forces server backpressure.
        received.pause();
        received.on('error', () => undefined);
        resolve(received);
      });
    });
    expect(response.statusCode).toBe(200);
    return {
      get serverClosed() {
        return serverClosed;
      },
      get finished() {
        return finished;
      },
      closed: closed.promise,
      dispose() {
        response.destroy();
        request.destroy();
      },
    };
  }

  it('matches exact legacy account evidence while downloading private files from one recorded boundary', async () => {
    const app = await fixture();
    const seller = await app.trader('download_seller');
    const buyer = await app.trader('download_buyer');
    await app.marketState('resume');
    const ask = await app.exchange.placeLimit({
      accountId: seller.user.accountId,
      sessionId: app.sessionId,
      commandId: randomUUID(),
      side: 'SELL',
      quantity: '0.4',
      price: '50000',
    });
    await app.exchange.placeLimit({
      accountId: buyer.user.accountId,
      sessionId: app.sessionId,
      commandId: randomUUID(),
      side: 'BUY',
      quantity: '0.1',
      price: '50000',
    });
    const legacy = (
      await buyer.browser.request('GET', `/api/history/${app.sessionId}/export`)
    ).json<HistoryExportView>();
    const bundle = await prepare(buyer.browser);
    expect(bundle).toMatchObject({
      sessionId: app.sessionId,
      accountId: buyer.user.accountId,
      auditScope: 'NONE',
      cursor: legacy.cursor,
    });
    const files = await contents(buyer.browser, bundle);
    for (const file of legacy.files.filter((file) => file.name !== 'manifest.csv'))
      expect(csvRows(files.get(file.name)!)).toEqual(csvRows(file.content));
    const text = [...files.values()].join('');
    expect(text).not.toContain(seller.user.accountId);
    expect(text).not.toContain(ask.order!.id);
    expect(text).not.toMatch(
      /makerOrderId|takerOrderId|buyOrderId|sellOrderId|password_hash|token_hash/,
    );
    expect(text).not.toContain(buyer.invitation.token);
    expect(csvRows(files.get('manifest.csv')!)).toEqual([
      {
        sessionId: app.sessionId,
        accountId: buyer.user.accountId,
        asOf: bundle.asOf,
        outboxCursor: bundle.cursor,
        scope: 'ACCOUNT',
        auditScope: 'NONE',
        baseAsset: 'BTC-SIM',
        quoteAsset: 'USD-SIM',
      },
    ]);
    expect((await stat(`${directory}/export-${bundle.exportId}`)).mode & 0o777).toBe(0o700);
    expect((await stat(`${directory}/export-${bundle.exportId}/orders.csv`)).mode & 0o777).toBe(
      0o600,
    );
    const forbidden = await buyer.browser.request('POST', `/api/history/${app.sessionId}/exports`, {
      accountId: seller.user.accountId,
    });
    expect(forbidden.statusCode).toBe(403);
    const missingCsrf = await buyer.browser.request(
      'POST',
      `/api/history/${app.sessionId}/exports`,
      {},
      { 'x-csrf-token': '' },
    );
    expect(missingCsrf.statusCode).toBe(403);
    const adminAccount = await prepare(app.admin, buyer.user.accountId);
    expect(adminAccount.auditScope).toBe('SESSION');
    expect(adminAccount.files.map((file) => file.name)).toContain('audit.csv');
    expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('exports over 10,000 audit rows and 5 MiB, and permits exact retry after a real download interruption', async () => {
    const app = await fixture();
    // Synthetic administrator evidence only; no fake financial rows or balances are introduced.
    await app.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result,created_at)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'EXPORT_VOLUME','='||repeat('x',450),jsonb_build_object('note',repeat('y',600)), '2025-01-01T00:00:00.123456Z' FROM generate_series(1,10001)`,
      [app.sessionId],
    );
    expect(
      (await app.admin.request('GET', `/api/history/${app.sessionId}/export`)).statusCode,
    ).toBe(413);
    const bundle = await prepare(app.admin);
    const file = bundle.files.find((file) => file.name === 'audit.csv')!;
    expect(file.rows).toBeGreaterThan(10_000);
    expect(file.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(JSON.stringify(bundle).length).toBeLessThan(5_000);
    const origin = await app.listen();
    const controller = new AbortController();
    const closed = deferred();
    app.httpServer.once('request', (_request, response) => response.once('close', closed.resolve));
    const response = await fetch(`${origin}${file.downloadUrl}`, {
      headers: { origin: API_ORIGIN, cookie: app.admin.cookieHeader },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect((await reader.read()).value!.length).toBeGreaterThan(0);
    controller.abort();
    await closed.promise;
    await reader.cancel().catch(() => undefined);
    const retried = await app.admin.request('GET', file.downloadUrl);
    expect(retried.statusCode).toBe(200);
    expect(createHash('sha256').update(retried.rawPayload).digest('hex')).toBe(file.sha256);
    const rows = csvRows(retried.body);
    const count = await app.sql.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM admin_audit WHERE session_id=$1',
      [app.sessionId],
    );
    expect(rows).toHaveLength(Number(count.rows[0]!.count));
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
    expect(
      rows
        .filter((row) => row.action === 'EXPORT_VOLUME')
        .every((row) => row.reason === `'=${'x'.repeat(450)}`),
    ).toBe(true);
    const frozenTransactions = await app.sql.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`,
    );
    expect(frozenTransactions.rows[0]!.count).toBe('0');
    expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('crosses financial page boundaries with real trades, exact totals, and no missing or duplicate records', async () => {
    const app = await fixture();
    const seller = await app.trader('many_seller');
    const buyer = await app.trader('many_buyer');
    await app.marketState('resume');
    await app.exchange.placeLimit({
      accountId: seller.user.accountId,
      sessionId: app.sessionId,
      commandId: randomUUID(),
      side: 'SELL',
      quantity: '0.6',
      price: '50000',
    });
    const ids: string[] = [];
    for (let index = 0; index < 520; index++) {
      const outcome = await app.exchange.placeLimit({
        accountId: buyer.user.accountId,
        sessionId: app.sessionId,
        commandId: randomUUID(),
        side: 'BUY',
        quantity: '0.0001',
        price: '50000',
      });
      expect(outcome.status).toBe('ACCEPTED');
      ids.push(outcome.order!.id);
    }
    const bundle = await prepare(buyer.browser);
    const files = await contents(buyer.browser, bundle);
    expect(new Set(csvRows(files.get('orders.csv')!).map((row) => row.id))).toEqual(new Set(ids));
    expect(csvRows(files.get('fills.csv')!)).toHaveLength(520);
    expect(csvRows(files.get('commands.csv')!)).toHaveLength(520);
    const entries = await app.sql.query<{ id: string }>(
      'SELECT id::text FROM journal_entries WHERE session_id=$1 AND account_id=$2',
      [app.sessionId, buyer.user.accountId],
    );
    expect(new Set(csvRows(files.get('activity.csv')!).map((row) => row.id))).toEqual(
      new Set(entries.rows.map((row) => row.id)),
    );
    expect(csvRows(files.get('balances.csv')!)).toContainEqual({
      accountId: buyer.user.accountId,
      asset: 'BTC-SIM',
      available: '1.0520',
      reserved: '0.0000',
      total: '1.0520',
    });
    const adminBundle = await prepare(app.admin);
    const globalFiles = await contents(app.admin, adminBundle);
    expect(csvRows(globalFiles.get('orders.csv')!)).toHaveLength(521);
    expect(csvRows(globalFiles.get('fills.csv')!)).toHaveLength(520);
    expect(
      csvRows(globalFiles.get('balances.csv')!)
        .filter((row) => row.asset === 'USD-SIM')
        .reduce((sum, row) => sum + BigInt(row.total!.replace('.', '')), 0n),
    ).toBe(0n);
    expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('keeps orders, fills, and balances at one snapshot while matching and cancellation commit', async () => {
    const app = await fixture();
    const seller = await app.trader('frozen_seller');
    const buyer = await app.trader('frozen_buyer');
    await app.marketState('resume');
    const sell = await app.exchange.placeLimit({
      accountId: seller.user.accountId,
      sessionId: app.sessionId,
      commandId: randomUUID(),
      side: 'SELL',
      quantity: '0.4',
      price: '50000',
    });
    const before = (
      await app.admin.request('GET', `/api/history/${app.sessionId}/export`)
    ).json<HistoryExportView>();
    const frozen = deferred();
    const release = deferred();
    const original = app.exchange.exportReadTransaction.bind(app.exchange);
    app.exchange.exportReadTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        frozen.resolve();
        await release.promise;
        return work(tx);
      });
    const pending = prepare(app.admin);
    await frozen.promise;
    app.exchange.exportReadTransaction = original;
    try {
      await app.exchange.placeLimit({
        accountId: buyer.user.accountId,
        sessionId: app.sessionId,
        commandId: randomUUID(),
        side: 'BUY',
        quantity: '0.1',
        price: '50000',
      });
      await app.exchange.cancel({
        accountId: seller.user.accountId,
        sessionId: app.sessionId,
        commandId: randomUUID(),
        orderId: sell.order!.id,
      });
    } finally {
      release.resolve();
    }
    const bundle = await pending;
    expect(bundle.cursor).toBe(before.cursor);
    const files = await contents(app.admin, bundle);
    for (const file of before.files.filter((file) => file.name !== 'manifest.csv'))
      expect(csvRows(files.get(file.name)!)).toEqual(csvRows(file.content));
    const after = await prepare(app.admin);
    expect(BigInt(after.cursor)).toBeGreaterThan(BigInt(bundle.cursor));
    expect(csvRows((await contents(app.admin, after)).get('fills.csv')!)).toHaveLength(1);
  });

  it('reauthorizes download ownership, suspension, expiry, and restart before opening private files', async () => {
    const app = await fixture({ exports: { ttlMs: 250 } });
    const trader = await app.trader('download_owner');
    const other = await app.trader('download_other');
    const bundle = await prepare(trader.browser);
    const file = bundle.files[0]!;
    expect((await other.browser.request('GET', file.downloadUrl)).statusCode).toBe(403);
    expect((await app.client().request('GET', file.downloadUrl)).statusCode).toBe(401);
    expect(
      (
        await trader.browser.request(
          'GET',
          `/api/history/exports/${bundle.exportId}/files/not-a-file.csv`,
        )
      ).statusCode,
    ).toBe(400);
    await app.admin.request('POST', `/api/admin/traders/${trader.user.accountId}/suspend`, {
      commandId: randomUUID(),
      sessionId: app.sessionId,
      reason: 'Exercise current download authorization',
    });
    expect((await trader.browser.request('GET', file.downloadUrl)).statusCode).toBe(401);
    const expiring = await prepare(app.admin);
    await until(
      async () =>
        (await app.admin.request('GET', expiring.files[0]!.downloadUrl)).statusCode === 410,
    );
    await until(async () => (await readdir(directory)).length === 0);
    const retained = await prepare(app.admin);
    await app.start();
    expect((await app.admin.request('GET', retained.files[0]!.downloadUrl)).statusCode).toBe(410);
    expect((await readdir(directory)).length).toBe(0);
    expect((await prepare(app.admin)).exportId).not.toBe(retained.exportId);
  });

  it('serializes simultaneous publication and evicts old ready exports within account and global quotas', async () => {
    const app = await fixture({ exports: { maxReady: 2, maxPerAccount: 2, maxConcurrent: 2 } });
    const first = await prepare(app.admin);
    const frozen = deferred();
    const release = deferred();
    const original = app.exchange.exportReadTransaction.bind(app.exchange);
    let started = 0;
    app.exchange.exportReadTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        if (++started === 2) frozen.resolve();
        await release.promise;
        return work(tx);
      });
    const pending = [prepare(app.admin), prepare(app.admin)];
    await frozen.promise;
    const busy = await app.admin.request('POST', `/api/history/${app.sessionId}/exports`, {});
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toMatchObject({ code: 'EXPORT_BUSY' });
    app.exchange.exportReadTransaction = original;
    release.resolve();
    const completed = await Promise.all(pending);
    expect((await readdir(directory)).length).toBe(2);
    expect((await app.admin.request('GET', first.files[0]!.downloadUrl)).statusCode).toBe(410);
    for (const bundle of completed)
      expect((await app.admin.request('GET', bundle.files[0]!.downloadUrl)).statusCode).toBe(200);
    const secondOwner = await app.trader('quota_second');
    const thirdOwner = await app.trader('quota_third');
    await Promise.all([prepare(secondOwner.browser), prepare(thirdOwner.browser)]);
    expect((await readdir(directory)).length).toBe(2);
    for (const bundle of completed)
      expect((await app.admin.request('GET', bundle.files[0]!.downloadUrl)).statusCode).toBe(410);
  });

  it('does not publish files when logout commits after the export snapshot authenticated its owner', async () => {
    const app = await fixture();
    const trader = await app.trader('download_logout');
    const frozen = deferred();
    const release = deferred();
    const original = app.exchange.exportReadTransaction.bind(app.exchange);
    app.exchange.exportReadTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        frozen.resolve();
        await release.promise;
        return work(tx);
      });
    const pending = trader.browser.request('POST', `/api/history/${app.sessionId}/exports`, {});
    await frozen.promise;
    app.exchange.exportReadTransaction = original;
    try {
      expect((await trader.browser.request('POST', '/api/auth/logout', {})).statusCode).toBe(200);
    } finally {
      release.resolve();
    }
    const failed = await pending;
    expect(failed.statusCode).toBe(401);
    expect(failed.json()).not.toHaveProperty('files');
    expect(await readdir(directory)).toEqual([]);
    expect((await trader.browser.login('download_logout')).statusCode).toBe(200);
    expect((await prepare(trader.browser)).files.length).toBe(6);
  });

  it('removes byte-limit failures without publishing partial files or retaining preparation capacity', async () => {
    const app = await fixture({ exports: { maxBytes: 4096, maxConcurrent: 1 } });
    await app.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result) VALUES(gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'EXPORT_BOUND','Bounded fixture',jsonb_build_object('note',repeat('x',9000)))`,
      [app.sessionId],
    );
    const failed = await app.admin.request('POST', `/api/history/${app.sessionId}/exports`, {});
    expect(failed.statusCode).toBe(413);
    expect(failed.json()).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(failed.json()).not.toHaveProperty('files');
    expect(await readdir(directory)).toEqual([]);
    const trader = await app.trader('small_retry');
    expect((await prepare(trader.browser)).files.map((file) => file.name)).not.toContain(
      'audit.csv',
    );
  });

  it('fences a timed-out callback and cannot recreate files when it resumes after deadline cleanup', async () => {
    const app = await fixture({
      database: {
        budgets: { ...DEFAULT_DATABASE_BUDGETS, export: { statementMs: 50, totalMs: 100 } },
      },
    });
    const frozen = deferred();
    const release = deferred();
    const resumed = deferred();
    const original = app.exchange.exportReadTransaction.bind(app.exchange);
    app.exchange.exportReadTransaction = (work) =>
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
    const pending = app.admin.request('POST', `/api/history/${app.sessionId}/exports`, {});
    await frozen.promise;
    const failed = await pending;
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toMatchObject({ code: 'DATABASE_TIMEOUT' });
    expect(await readdir(directory)).toEqual([]);
    app.exchange.exportReadTransaction = original;
    release.resolve();
    await resumed.promise;
    expect(await readdir(directory)).toEqual([]);
    expect((await prepare(app.admin)).files.length).toBe(7);
    expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('stops an observed preparation disconnect between batches and releases capacity after cleanup', async () => {
    const app = await fixture({ exports: { maxConcurrent: 1 } });
    const origin = await app.listen();
    const frozen = deferred();
    const release = deferred();
    const closed = deferred();
    const original = app.exchange.exportReadTransaction.bind(app.exchange);
    app.exchange.exportReadTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        frozen.resolve();
        await release.promise;
        return work(tx);
      });
    app.httpServer.once('request', (_request, response) => response.once('close', closed.resolve));
    const controller = new AbortController();
    const request = fetch(`${origin}/api/history/${app.sessionId}/exports`, {
      method: 'POST',
      headers: {
        origin: API_ORIGIN,
        cookie: app.admin.cookieHeader,
        'x-csrf-token': app.admin.csrfToken,
        'content-type': 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await frozen.promise;
    controller.abort();
    await closed.promise;
    expect(await request).toBeInstanceOf(Error);
    expect(
      (await app.admin.request('POST', `/api/history/${app.sessionId}/exports`, {})).statusCode,
    ).toBe(503);
    app.exchange.exportReadTransaction = original;
    release.resolve();
    await until(async () => (await readdir(directory)).length === 0);
    expect((await prepare(app.admin)).files.length).toBe(7);
    expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('disconnects slow downloads at their deadline and releases stream capacity for exact retry', async () => {
    const app = await fixture({ exports: { downloadMs: 500 } });
    const { file } = await largeAuditFile(app);
    const origin = await app.listen();
    const first = await pausedDownload(app, origin, file.downloadUrl);
    const second = await pausedDownload(app, origin, file.downloadUrl);
    try {
      const limited = await app.admin.request('GET', file.downloadUrl);
      expect(limited.statusCode).toBe(503);
      expect(limited.json()).toMatchObject({ code: 'EXPORT_DOWNLOAD_LIMIT' });
      await until(async () => first.serverClosed && second.serverClosed);
      expect(first.finished).toBe(false);
      expect(second.finished).toBe(false);
      const retry = await app.admin.request('GET', file.downloadUrl);
      expect(retry.statusCode).toBe(200);
      expect(createHash('sha256').update(retry.rawPayload).digest('hex')).toBe(file.sha256);
      const transactions = await app.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`,
      );
      expect(transactions.rows[0]!.count).toBe('0');
    } finally {
      first.dispose();
      second.dispose();
    }
  });

  it('closes an active download during shutdown, removes its private files, and permits fresh exports after restart', async () => {
    const app = await fixture({ exports: { downloadMs: 10_000 } });
    const { bundle, file } = await largeAuditFile(app);
    const origin = await app.listen();
    const downloading = await pausedDownload(app, origin, file.downloadUrl);
    try {
      expect(downloading.serverClosed).toBe(false);
      await app.stop();
      await downloading.closed;
      expect(downloading.finished).toBe(false);
      expect(await readdir(directory)).toEqual([]);
      const transactions = await app.sql.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'`,
      );
      expect(transactions.rows[0]!.count).toBe('0');
      await app.start();
      expect((await app.admin.request('GET', file.downloadUrl)).statusCode).toBe(410);
      expect((await prepare(app.admin)).exportId).not.toBe(bundle.exportId);
      expect(await app.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      downloading.dispose();
    }
  });
});
