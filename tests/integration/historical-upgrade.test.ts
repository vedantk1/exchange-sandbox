import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { AdminService } from '../../apps/server/src/admin/service.js';
import { AuthService } from '../../apps/server/src/auth/index.js';
import { initializeOwner } from '../../apps/server/src/deploy/owner-initialization.js';
import { Exchange } from '../../apps/server/src/exchange.js';
import { isolatedDatabase } from '../../apps/server/src/operations/database.js';
import { TEST_PASSWORD } from '../helpers/api.js';
import { frozen008Installation } from '../helpers/historical.js';

it('upgrades the independently frozen008 release through owner tooling and preserves exact evidence and recovery', async () => {
  const fixture = await frozen008Installation();
  const context = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
  const owner = new pg.Client({ connectionString: context.url });
  const roleName = `sandbox_historical_${randomUUID().replaceAll('-', '')}`;
  const runtimeUrl = new URL(context.url);
  runtimeUrl.username = roleName;
  runtimeUrl.password = randomBytes(32).toString('hex');
  let exchange: Exchange | undefined;
  await owner.connect();
  try {
    await owner.query("SET TIME ZONE 'UTC'");
    await owner.query(fixture.sql);
    expect(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM users WHERE password_hash <> 'disabled historical fixture credential'",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect((await owner.query('SELECT count(*)::int AS count FROM login_sessions')).rows).toEqual([
      { count: 0 },
    ]);
    expect(
      (
        await owner.query(
          "SELECT count(*)::int AS count FROM invitations WHERE token_hash <> md5(id::text) || md5('disabled-' || id::text)",
        )
      ).rows,
    ).toEqual([{ count: 0 }]);
    expect((await owner.query('SELECT name FROM schema_migrations ORDER BY name')).rows).toEqual(
      fixture.manifest.migrationStatements.map(({ name }) => ({ name })),
    );
    expect((await owner.query('SELECT type, status FROM orders')).rows).toEqual(
      expect.arrayContaining([
        { type: 'LIMIT', status: 'OPEN' },
        { type: 'LIMIT', status: 'PARTIALLY_FILLED' },
        { type: 'LIMIT', status: 'FILLED' },
        { type: 'LIMIT', status: 'CANCELED' },
        { type: 'MARKET', status: 'FILLED' },
        { type: 'MARKET', status: 'CANCELED' },
      ]),
    );
    const evidenceTables = Object.keys(fixture.manifest.rows).filter(
      (table) => table !== 'schema_migrations',
    );
    async function evidence() {
      const result: Record<string, string[]> = {};
      for (const table of evidenceTables) {
        // PostgreSQL preserves all integer precision and microseconds. Writer
        // acquisition alone intentionally changes its epoch on each startup.
        const expression =
          table === 'exchange_control' ? "to_jsonb(t) - 'writer_epoch'" : 'to_jsonb(t)';
        const rows = await owner.query<{ row: string }>(
          `SELECT (${expression})::text AS row FROM ${table} t ORDER BY (${expression})::text`,
        );
        result[table] = rows.rows.map(({ row }) => row);
      }
      return result;
    }
    const original = await evidence();
    const versions = (
      await owner.query('SELECT name, applied_at::text FROM schema_migrations ORDER BY name')
    ).rows;
    await expect(Exchange.open(context.url, { migrations: 'verify' })).rejects.toMatchObject({
      code: 'MIGRATION_ADOPTION_REQUIRED',
    });
    // Owner tooling must explicitly acknowledge adoption of an old installation;
    // failure does not silently stamp its migration metadata or run missing SQL.
    await expect(initializeOwner(context.url, runtimeUrl)).rejects.toMatchObject({
      code: 'MIGRATION_ADOPTION_REQUIRED',
    });
    expect(await evidence()).toEqual(original);
    expect(
      (await owner.query('SELECT name, applied_at::text FROM schema_migrations ORDER BY name'))
        .rows,
    ).toEqual(versions);
    await initializeOwner(context.url, runtimeUrl, { legacyBaseline: '008_order_integrity' });
    expect(await evidence()).toEqual(original);
    expect(
      (
        await owner.query(
          "SELECT name, applied_at::text FROM schema_migrations WHERE name <= '008_order_integrity' ORDER BY name",
        )
      ).rows,
    ).toEqual(versions);
    expect(
      (
        await owner.query(
          "SELECT name, checksum FROM schema_migrations WHERE name <= '008_order_integrity' ORDER BY name",
        )
      ).rows,
    ).toEqual(
      fixture.manifest.migrationStatements.map(({ name, sha256 }) => ({ name, checksum: sha256 })),
    );
    exchange = await Exchange.open(runtimeUrl.toString(), { migrations: 'verify' });
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
    expect(await evidence()).toEqual(original);
    const { expected } = fixture;
    async function replayFinancial() {
      expect(await exchange!.placeLimit(expected.commands.archivedSell)).toEqual(
        expected.results.archivedSell,
      );
      expect(await exchange!.placeLimit(expected.commands.archivedBuy)).toEqual(
        expected.results.archivedBuy,
      );
      expect(await exchange!.placeLimit(expected.commands.buy)).toEqual(expected.results.buy);
      expect(await exchange!.cancel(expected.commands.cancel)).toEqual(expected.results.cancel);
      expect(await exchange!.placeMarket(expected.commands.market)).toEqual(
        expected.results.market,
      );
      expect(await exchange!.placeMarket(expected.commands.partialMarket)).toEqual(
        expected.results.partialMarket,
      );
    }
    await replayFinancial();
    expect(await evidence()).toEqual(original);
    for (const orderId of Object.values(expected.orderIds)) {
      await expect(
        owner.query("UPDATE orders SET created_at=created_at + interval '1 second' WHERE id=$1", [
          orderId,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(owner.query('DELETE FROM orders WHERE id=$1', [orderId])).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect(await evidence()).toEqual(original);

    // The frozen fixture deliberately has no usable credential. Exercise the
    // preserved identity through the supported owner recovery operation only
    // after comparing every row, including the disabled credential sentinel.
    await exchange.close();
    const recoveryOwner = await Exchange.open(context.url, { migrations: 'verify' });
    try {
      expect(
        await new AuthService(recoveryOwner).resetAdminPassword({ password: TEST_PASSWORD }),
      ).toEqual({
        accountId: expected.operator.accountId,
        handle: expected.operator.handle,
        role: 'ADMIN',
      });
    } finally {
      await recoveryOwner.close();
    }
    exchange = await Exchange.open(runtimeUrl.toString(), { migrations: 'verify' });
    const auth = new AuthService(exchange);
    let login = await auth.login({ handle: expected.operator.handle, password: TEST_PASSWORD });
    const afterLogin = await evidence();
    const admin = new AdminService(exchange);
    expect(await admin.rollover(login.token, expected.commands.rollover)).toEqual(
      expected.results.rollover,
    );
    expect(await evidence()).toEqual(afterLogin);
    expect((await owner.query('SELECT count(*)::int AS count FROM allocations')).rows).toEqual([
      { count: 4 },
    ]);
    const archivedBefore = original.orders!.filter(
      (row) => JSON.parse(row).session_id === expected.archivedSessionId,
    );
    const finish = await exchange.placeLimit({
      accountId: expected.buyer,
      commandId: randomUUID(),
      sessionId: expected.sessionId,
      side: 'BUY',
      quantity: '0.2',
      price: '50000',
    });
    expect(finish.order?.status).toBe('FILLED');
    expect(
      (await owner.query('SELECT status FROM orders WHERE id=$1', [expected.orderIds.partial]))
        .rows,
    ).toEqual([{ status: 'FILLED' }]);
    const cancel = {
      accountId: expected.seller,
      commandId: randomUUID(),
      sessionId: expected.sessionId,
      orderId: expected.orderIds.open,
    };
    const canceled = await exchange.cancel(cancel);
    expect(canceled.order).toMatchObject({ status: 'CANCELED', reserved: '0.0000' });
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
    const settled = await evidence();
    expect(
      settled.orders!.filter((row) => JSON.parse(row).session_id === expected.archivedSessionId),
    ).toEqual(archivedBefore);
    await exchange.close();
    exchange = await Exchange.open(runtimeUrl.toString(), { migrations: 'verify' });
    await replayFinancial();
    expect(await exchange.cancel(cancel)).toEqual(canceled);
    login = await new AuthService(exchange).login({
      handle: expected.operator.handle,
      password: TEST_PASSWORD,
    });
    const restarted = await evidence();
    expect(
      await new AdminService(exchange).rollover(login.token, expected.commands.rollover),
    ).toEqual(expected.results.rollover);
    expect(await evidence()).toEqual(restarted);
    // New login sessions are the only extra evidence from the auth check.
    expect({ ...restarted, login_sessions: settled.login_sessions }).toEqual(settled);
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
  } finally {
    await exchange?.close();
    // A failed frozen SQL load may leave its explicit transaction aborted.
    await owner.query('ROLLBACK').catch(() => undefined);
    await owner.query(`DROP OWNED BY "${roleName}"`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await owner.end();
    await context.dispose();
  }
});
