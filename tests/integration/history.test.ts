import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AccountSearchView,
  HistoryExportView,
  HistoryView,
  HistoryPageView,
  SessionsView,
  WorkspaceView,
} from '../../packages/contracts/src/index.js';
import { createApiFixture, type ApiFixture } from '../helpers/api.js';
import { csvText } from '../../apps/server/src/history/export.js';
import { historyExport } from '../../apps/server/src/history/index.js';

function token(cookie: string): string {
  return cookie
    .split('; ')
    .find((value) => value.startsWith('sandbox_session='))!
    .split('=')[1]!;
}

async function pageAll(
  context: ApiFixture,
  browser: ApiFixture['admin'],
  kind: string,
  extra = '',
) {
  const items: HistoryPageView['items'] = [];
  let cursor: string | null = null;
  do {
    const response = await browser.request(
      'GET',
      `/api/history/${context.sessionId}/page?kind=${kind}&limit=25${extra}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    expect(response.statusCode).toBe(200);
    const page = response.json<HistoryPageView>();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

function csvRows(text: string): Record<string, string>[] {
  const cells = [...text.matchAll(/"((?:[^"]|"")*)"(?:,|\r\n)/g)].map((match) =>
    match[1]!.replaceAll('""', '"'),
  );
  const width = text.slice(0, text.indexOf('\r\n')).split(',').length;
  const columns = cells.splice(0, width);
  const rows: Record<string, string>[] = [];
  for (let offset = 0; offset < cells.length; offset += width)
    rows.push(Object.fromEntries(columns.map((column, index) => [column, cells[offset + index]!])));
  return rows;
}

const order = (sessionId: string, accountId: string, side: 'BUY' | 'SELL', quantity: string) => ({
  commandId: randomUUID(),
  sessionId,
  accountId,
  side,
  quantity,
  price: '50000',
});

describe('complete scoped session history and consistent CSV exports', () => {
  let context: ApiFixture;
  beforeEach(async () => {
    context = await createApiFixture();
  });
  afterEach(async () => {
    await context?.dispose();
  });

  it('reaches every order, fill, ledger entry and command beyond the workspace limit with matching keysets', async () => {
    const seller = await context.trader('history_seller');
    const buyer = await context.trader('history_buyer');
    await context.marketState('resume');
    await context.exchange.placeLimit(
      order(context.sessionId, seller.user.accountId, 'SELL', '0.5'),
    );
    const ids: string[] = [];
    for (let index = 0; index < 105; index += 1) {
      const result = await context.exchange.placeLimit(
        order(context.sessionId, buyer.user.accountId, 'BUY', '0.001'),
      );
      expect(result.status).toBe('ACCEPTED');
      ids.push(result.order!.id);
    }
    const orders = await pageAll(context, buyer.browser, 'orders');
    const fills = await pageAll(context, buyer.browser, 'fills');
    const activity = await pageAll(context, buyer.browser, 'activity');
    const commands = await pageAll(context, buyer.browser, 'commands');
    expect(orders).toHaveLength(105);
    expect(new Set(orders.map((item) => ('id' in item ? item.id : null)))).toEqual(new Set(ids));
    expect(fills).toHaveLength(105);
    expect(commands).toHaveLength(105);
    const count = await context.sql.query<{ count: string }>(
      'SELECT count(*)::text FROM journal_entries WHERE account_id=$1',
      [buyer.user.accountId],
    );
    expect(activity).toHaveLength(Number(count.rows[0]!.count));
    expect(new Set(activity.map((item) => ('id' in item ? item.id : null))).size).toBe(
      activity.length,
    );
    const entry = activity.find((item) => 'id' in item)!;
    const ledgerLookup = (
      await buyer.browser.request(
        'GET',
        `/api/history/${context.sessionId}/page?kind=activity&search=${'id' in entry ? entry.id : ''}`,
      )
    ).json<HistoryPageView>();
    expect(ledgerLookup.items).toContainEqual(entry);
    const first = (
      await buyer.browser.request(
        'GET',
        `/api/history/${context.sessionId}/page?kind=orders&limit=25&side=BUY&status=FILLED`,
      )
    ).json<HistoryPageView>();
    expect(first.nextCursor).toBeTruthy();
    expect(
      (
        await buyer.browser.request(
          'GET',
          `/api/history/${context.sessionId}/page?kind=orders&limit=25&side=SELL&status=FILLED&cursor=${first.nextCursor}`,
        )
      ).statusCode,
    ).toBe(400);
    const lookup = (
      await buyer.browser.request(
        'GET',
        `/api/history/${context.sessionId}/page?kind=orders&search=${ids[0]}`,
      )
    ).json<HistoryPageView>();
    expect(lookup.items).toMatchObject([{ id: ids[0] }]);
    for (const limit of ['0', '101', '-1', '1.5'])
      expect(
        (
          await buyer.browser.request(
            'GET',
            `/api/history/${context.sessionId}/page?kind=orders&limit=${limit}`,
          )
        ).statusCode,
      ).toBe(400);
    const forbiddenCursor = await seller.browser.request(
      'GET',
      `/api/history/${context.sessionId}/page?kind=orders&side=BUY&status=FILLED&cursor=${first.nextCursor}`,
    );
    expect(forbiddenCursor.statusCode).toBe(400);
    const malformed = await buyer.browser.request(
      'GET',
      `/api/history/${context.sessionId}/page?kind=orders&cursor=not-a-valid-cursor`,
    );
    expect(malformed.statusCode).toBe(400);
  });

  it('keeps trader exports private and admin session exports complete with exact balances and escaped audit text', async () => {
    const seller = await context.trader('export_seller');
    const buyer = await context.trader('export_buyer');
    await context.marketState('resume');
    const ask = await context.exchange.placeLimit(
      order(context.sessionId, seller.user.accountId, 'SELL', '0.4'),
    );
    const bid = await context.exchange.placeLimit(
      order(context.sessionId, buyer.user.accountId, 'BUY', '0.1'),
    );
    await context.admin.request('POST', '/api/admin/market/pause', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: '=HYPERLINK("example","CSV reason")',
    });
    const ownResponse = await buyer.browser.request(
      'GET',
      `/api/history/${context.sessionId}/export`,
    );
    expect(ownResponse.statusCode).toBe(200);
    const own = ownResponse.json<HistoryExportView>();
    expect(own.accountId).toBe(buyer.user.accountId);
    expect(own.files.map((file) => file.name)).toEqual([
      'manifest.csv',
      'orders.csv',
      'fills.csv',
      'activity.csv',
      'commands.csv',
      'balances.csv',
    ]);
    const ownText = own.files.map((file) => file.content).join('');
    expect(ownText).not.toContain(seller.user.accountId);
    expect(ownText).not.toContain(ask.order!.id);
    expect(ownText).not.toMatch(
      /makerOrderId|takerOrderId|buyOrderId|sellOrderId|password_hash|token_hash/,
    );
    const ownBalances = csvRows(own.files.find((file) => file.name === 'balances.csv')!.content);
    expect(ownBalances).toContainEqual({
      accountId: buyer.user.accountId,
      asset: 'USD-SIM',
      available: '94995.000000000',
      reserved: '0.000000000',
      total: '94995.000000000',
    });
    expect(ownBalances).toContainEqual({
      accountId: buyer.user.accountId,
      asset: 'BTC-SIM',
      available: '1.1000',
      reserved: '0.0000',
      total: '1.1000',
    });
    const ownManifest = csvRows(own.files[0]!.content)[0]!;
    expect(ownManifest).toMatchObject({
      sessionId: context.sessionId,
      accountId: buyer.user.accountId,
      asOf: own.asOf,
      outboxCursor: own.cursor,
      scope: 'ACCOUNT',
    });
    for (const suffix of [
      `/page?kind=orders&accountId=${seller.user.accountId}`,
      `/export?accountId=${seller.user.accountId}`,
      '/page?kind=audit',
    ])
      expect(
        (await buyer.browser.request('GET', `/api/history/${context.sessionId}${suffix}`))
          .statusCode,
      ).toBe(403);
    const adminResponse = await context.admin.request(
      'GET',
      `/api/history/${context.sessionId}/export`,
    );
    expect(adminResponse.statusCode).toBe(200);
    const admin = adminResponse.json<HistoryExportView>();
    expect(admin.accountId).toBeNull();
    expect(admin.files.map((file) => file.name)).toEqual([
      'manifest.csv',
      'orders.csv',
      'fills.csv',
      'activity.csv',
      'commands.csv',
      'balances.csv',
      'audit.csv',
    ]);
    const fills = csvRows(admin.files.find((file) => file.name === 'fills.csv')!.content);
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({
      buyerAccountId: buyer.user.accountId,
      sellerAccountId: seller.user.accountId,
      buyOrderId: bid.order!.id,
      sellOrderId: ask.order!.id,
      buyerFee: '5.000000000',
      sellerFee: '5.000000000',
    });
    const workspace = (await context.admin.request('GET', '/api/workspace')).json<WorkspaceView>();
    const feeId = workspace.admin!.overview.feeAccountId!;
    const issuanceId = workspace.admin!.overview.issuanceAccountId!;
    const balances = csvRows(admin.files.find((file) => file.name === 'balances.csv')!.content);
    for (const asset of ['BTC-SIM', 'USD-SIM']) {
      expect(
        balances
          .filter((row) => row.asset === asset)
          .reduce((sum, row) => sum + BigInt(row.total!.replace('.', '')), 0n),
      ).toBe(0n);
    }
    expect(balances).toContainEqual({
      accountId: feeId,
      asset: 'USD-SIM',
      available: '10.000000000',
      reserved: '0.000000000',
      total: '10.000000000',
    });
    expect(balances).toContainEqual({
      accountId: feeId,
      asset: 'BTC-SIM',
      available: '0.0000',
      reserved: '0.0000',
      total: '0.0000',
    });
    expect(balances).toContainEqual({
      accountId: issuanceId,
      asset: 'USD-SIM',
      available: '-200000.000000000',
      reserved: '0.000000000',
      total: '-200000.000000000',
    });
    expect(
      csvRows(admin.files.find((file) => file.name === 'audit.csv')!.content).some(
        (row) => row.reason === '\'=HYPERLINK("example","CSV reason")',
      ),
    ).toBe(true);
    expect(JSON.stringify(admin)).not.toContain(buyer.invitation.token);
    expect(
      (await context.client().request('GET', `/api/history/${context.sessionId}/export`))
        .statusCode,
    ).toBe(401);
  });

  it('records one export boundary when a trade commits during its repeatable-read snapshot', async () => {
    const seller = await context.trader('snapshot_seller');
    const buyer = await context.trader('snapshot_buyer');
    await context.marketState('resume');
    await context.exchange.placeLimit(
      order(context.sessionId, seller.user.accountId, 'SELL', '0.4'),
    );
    const before = await historyExport(
      context.exchange,
      token(context.admin.cookieHeader),
      context.sessionId,
    );
    const original = context.exchange.readTransaction.bind(context.exchange);
    let freeze!: () => void;
    let release!: () => void;
    const frozen = new Promise<void>((resolve) => {
      freeze = resolve;
    });
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    context.exchange.readTransaction = (work) =>
      original(async (tx) => {
        await tx.selectFrom('exchange_control').select('id').execute();
        freeze();
        await proceed;
        return work(tx);
      });
    const pending = historyExport(
      context.exchange,
      token(context.admin.cookieHeader),
      context.sessionId,
    );
    await frozen;
    context.exchange.readTransaction = original;
    try {
      await context.exchange.placeLimit(
        order(context.sessionId, buyer.user.accountId, 'BUY', '0.1'),
      );
    } finally {
      release();
    }
    const during = await pending;
    const fillTimestamp = (
      await context.sql.query<{ created_at: Date }>('SELECT created_at FROM fills LIMIT 1')
    ).rows[0]!.created_at;
    expect(new Date(during.asOf).getTime()).toBeLessThanOrEqual(fillTimestamp.getTime());
    expect(during.cursor).toBe(before.cursor);
    expect(during.files.filter((file) => file.name !== 'manifest.csv')).toEqual(
      before.files.filter((file) => file.name !== 'manifest.csv'),
    );
    expect(csvRows(during.files[0]!.content)[0]!.asOf).toBe(during.asOf);
    const after = await historyExport(
      context.exchange,
      token(context.admin.cookieHeader),
      context.sessionId,
    );
    expect(BigInt(after.cursor)).toBeGreaterThan(BigInt(during.cursor));
    expect(csvRows(after.files.find((file) => file.name === 'fills.csv')!.content)).toHaveLength(1);
  });

  it('searches all accounts beyond the original 200 participants and binds account search cursors', async () => {
    const original = await context.trader('baseline');
    await context.sql.query(
      `WITH accounts AS (INSERT INTO accounts (id,kind,label) SELECT gen_random_uuid(),'TRADER','participant_'||lpad(i::text,4,'0') FROM generate_series(1,205) i RETURNING id,label)
      INSERT INTO users (account_id,role,handle,password_hash) SELECT id,'TRADER',label,(SELECT password_hash FROM users WHERE account_id=$1) FROM accounts`,
      [original.user.accountId],
    );
    const response = await context.admin.request(
      'GET',
      '/api/admin/accounts/search?search=participant_0205&limit=20',
    );
    expect(response.statusCode).toBe(200);
    const result = response.json<AccountSearchView>();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.handle).toBe('participant_0205');
    const byId = (
      await context.admin.request(
        'GET',
        `/api/admin/accounts/search?search=${result.items[0]!.accountId}`,
      )
    ).json<AccountSearchView>();
    expect(byId.items).toEqual(result.items);
    const first = (
      await context.admin.request('GET', '/api/admin/accounts/search?limit=100')
    ).json<AccountSearchView>();
    const second = (
      await context.admin.request(
        'GET',
        `/api/admin/accounts/search?limit=100&cursor=${first.nextCursor}`,
      )
    ).json<AccountSearchView>();
    const third = (
      await context.admin.request(
        'GET',
        `/api/admin/accounts/search?limit=100&cursor=${second.nextCursor}`,
      )
    ).json<AccountSearchView>();
    expect(
      new Set([...first.items, ...second.items, ...third.items].map((row) => row.accountId)).size,
    ).toBe(206);
    expect(third.nextCursor).toBeNull();
    expect(
      (
        await context.admin.request(
          'GET',
          `/api/admin/accounts/search?search=participant&cursor=${first.nextCursor}`,
        )
      ).statusCode,
    ).toBe(400);
    expect((await original.browser.request('GET', '/api/admin/accounts/search')).statusCode).toBe(
      403,
    );
    expect(
      (
        await context.admin.request('GET', '/api/admin/accounts/search?search=participant_%25')
      ).json<AccountSearchView>().items,
    ).toEqual([]);
  });

  it('counts archived financial participants independently of later enrollment and preserves order lookup scope', async () => {
    const first = await context.trader('archive_first');
    await context.marketState('resume');
    const resting = await context.exchange.placeLimit(
      order(context.sessionId, first.user.accountId, 'SELL', '0.1'),
    );
    await context.marketState('pause');
    const rollover = await context.admin.request('POST', '/api/admin/sessions/rollover', {
      commandId: randomUUID(),
      sessionId: context.sessionId,
      reason: 'Start an isolated history session',
    });
    expect(rollover.json()).toMatchObject({ status: 'ACCEPTED' });
    const newSessionId = rollover.json<{ data: { newSessionId: string } }>().data.newSessionId;
    const invitation = await context.admin.request('POST', '/api/admin/invitations', {
      commandId: randomUUID(),
      sessionId: newSessionId,
      reason: 'Enroll after archive completion',
    });
    const second = context.client();
    await second.request('POST', '/api/auth/redeem', {
      token: invitation.json<{ token: string }>().token,
      handle: 'archive_second',
      password: 'simulation-test-password',
    });
    expect((await second.login('archive_second')).statusCode).toBe(200);
    const archive = (
      await context.admin.request('GET', `/api/history/${context.sessionId}`)
    ).json<HistoryView>();
    const current = (
      await context.admin.request('GET', `/api/history/${newSessionId}`)
    ).json<HistoryView>();
    expect(archive.admin!.overview.counts.traders).toBe('1');
    expect(archive.admin!.traders.map((row) => row.accountId)).toEqual([first.user.accountId]);
    expect(current.admin!.overview.counts.traders).toBe('2');
    const detail = await context.admin.request('GET', `/api/admin/orders/${resting.order!.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      sessionId: context.sessionId,
      order: { id: resting.order!.id, status: 'CANCELED', cancelReason: 'SESSION_ENDED' },
    });
    expect((await second.request('GET', `/api/orders/${resting.order!.id}`)).statusCode).toBe(404);
    const unrelated = (
      await second.request('GET', `/api/history/${context.sessionId}`)
    ).json<HistoryView>();
    expect(unrelated.account!.balances['BTC-SIM'].total).toBe('0.0000');
    expect(JSON.stringify(unrelated)).not.toContain(first.user.accountId);
  });

  it('preserves PostgreSQL timestamp precision through session and audit pagination', async () => {
    const ids = await context.sql.query<{
      id: string;
    }>(`INSERT INTO exchange_sessions(id,state,created_at,closed_at)
      SELECT gen_random_uuid(),'CLOSED','2025-01-01T00:00:00.123450Z'::timestamptz + i * interval '1 microsecond','2025-01-02T00:00:00Z'::timestamptz FROM generate_series(1,3) i RETURNING id`);
    let cursor: string | null = null;
    const sessions: string[] = [];
    do {
      const response = await context.admin.request(
        'GET',
        `/api/sessions?limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<SessionsView>();
      sessions.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(sessions)).toEqual(
      new Set([context.sessionId, ...ids.rows.map((row) => row.id)]),
    );
    const auditIds = await context.sql.query<{ id: string; command_id: string }>(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result,created_at)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'TEST_HISTORY_PRECISION','Precision audit marker','{}','2025-01-01T00:00:00.123456Z' FROM generate_series(1,3) RETURNING id,command_id`,
      [context.sessionId],
    );
    const seen: string[] = [];
    cursor = null;
    do {
      const response = await context.admin.request(
        'GET',
        `/api/history/${context.sessionId}/page?kind=audit&search=Precision&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      );
      expect(response.statusCode).toBe(200);
      const page = response.json<HistoryPageView>();
      seen.push(...page.items.map((row) => ('id' in row ? row.id : '')));
      cursor = page.nextCursor;
    } while (cursor);
    expect(new Set(seen)).toEqual(new Set(auditIds.rows.map((row) => row.id)));
    for (const search of [auditIds.rows[0]!.id, auditIds.rows[0]!.command_id]) {
      const lookup = (
        await context.admin.request(
          'GET',
          `/api/history/${context.sessionId}/page?kind=audit&search=${search}`,
        )
      ).json<HistoryPageView>();
      expect(lookup.items).toMatchObject([{ id: auditIds.rows[0]!.id }]);
    }
  });

  it('rejects an oversized bundle explicitly instead of silently exporting a truncated audit', async () => {
    await context.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'TEST_EXPORT_VOLUME','Bounded export fixture','{}' FROM generate_series(1,10001)`,
      [context.sessionId],
    );
    const response = await context.admin.request('GET', `/api/history/${context.sessionId}/export`);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(response.json()).not.toHaveProperty('files');
  });

  it('rejects a bundle above the byte budget even when the row count is small', async () => {
    await context.sql.query(
      `INSERT INTO admin_audit(id,actor_id,command_id,session_id,action,reason,result)
      SELECT gen_random_uuid(),(SELECT account_id FROM users WHERE role='ADMIN'),gen_random_uuid(),$1,'TEST_EXPORT_BYTES','Bounded byte fixture',jsonb_build_object('note',repeat('x',3000000)) FROM generate_series(1,2)`,
      [context.sessionId],
    );
    const response = await context.admin.request('GET', `/api/history/${context.sessionId}/export`);
    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ code: 'EXPORT_TOO_LARGE' });
    expect(response.json()).not.toHaveProperty('files');
  });
});

describe('CSV text safety', () => {
  it('quotes embedded commas, quotes and newlines, protects formulas and retains exact negative decimals', () => {
    expect(
      csvText(
        ['reason', 'amount'],
        [
          { reason: 'comma,"quoted"\r\nnew line', amount: '-12.000000001' },
          { reason: '\t=HYPERLINK("example")', amount: '0.000000001' },
          { reason: '+SUM(1,2)', amount: '-2' },
        ],
        ['amount'],
      ),
    ).toBe(
      '"reason","amount"\r\n"comma,""quoted""\r\nnew line","-12.000000001"\r\n"\'\t=HYPERLINK(""example"")","0.000000001"\r\n"\'+SUM(1,2)","-2"\r\n',
    );
  });
});
