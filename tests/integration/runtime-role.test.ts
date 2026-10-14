import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Exchange } from '../../apps/server/src/exchange.js';
import { provisionRuntimeRole } from '../../apps/server/src/deploy/runtime-role.js';
import { isolatedDatabase } from '../../apps/server/src/operations/database.js';
import { initializeOwner } from '../../apps/server/src/deploy/owner-initialization.js';

describe('owner migration and restricted application database role', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let owner: pg.Client;
  let runtime: pg.Client | undefined;
  let exchange: Exchange | undefined;
  let roleName: string;
  let runtimeUrl: string;
  beforeEach(async () => {
    database = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    const migration = await Exchange.open(database.url);
    await migration.close();
    roleName = `sandbox_runtime_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(database.url);
    url.username = roleName;
    url.password = randomBytes(32).toString('hex');
    runtimeUrl = url.toString();
  });
  afterEach(async () => {
    await exchange?.close();
    exchange = undefined;
    await runtime?.end();
    runtime = undefined;
    await owner.query(`DROP OWNED BY "${roleName}"`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await owner.end();
    await database.dispose();
  });
  async function provision() {
    await provisionRuntimeRole(owner, decodeURIComponent(new URL(runtimeUrl).password), roleName);
    runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
  }
  it('runs bounded owner initialization and verifies the migrated restricted runtime', async () => {
    await initializeOwner(database.url, new URL(runtimeUrl));
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    expect((await exchange.reconcile()).ok).toBe(true);
    runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
    await expect(
      runtime.query('CREATE TABLE public.unauthorized_owner_probe(id int)'),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('rejects CREATE/ALTER/DROP and migration metadata writes while exact financial commands work', async () => {
    await provision();
    for (const statement of [
      'CREATE TABLE public.permission_probe(id int)',
      'CREATE SCHEMA permission_probe',
      'ALTER TABLE public.orders ADD COLUMN unauthorized int',
      'DROP TABLE public.orders CASCADE',
      'UPDATE schema_migrations SET name=name',
      'DELETE FROM schema_migrations',
    ]) {
      await expect(runtime!.query(statement)).rejects.toMatchObject({ code: '42501' });
    }
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    const setup = await exchange.bootstrap();
    const seller = randomUUID();
    const buyer = randomUUID();
    await exchange.createTrader({ accountId: seller, label: 'seller', commandId: randomUUID() });
    await exchange.createTrader({ accountId: buyer, label: 'buyer', commandId: randomUUID() });
    const ask = await exchange.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId: setup.sessionId,
      side: 'SELL',
      quantity: '0.2',
      price: '50000',
    });
    const input = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId: setup.sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    const buy = await exchange.placeLimit(input);
    expect(buy.order?.status).toBe('FILLED');
    expect(
      (
        await exchange.cancel({
          accountId: seller,
          commandId: randomUUID(),
          sessionId: setup.sessionId,
          orderId: ask.order!.id,
        })
      ).order?.reserved,
    ).toBe('0.0000');
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
    await exchange.close();
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    expect(await exchange.placeLimit(input)).toEqual(buy);
    expect((await exchange.snapshot(buyer)).balances['USD-SIM'].available).toBe('94995.000000000');
  });
  it('removes prior membership so the application cannot SET ROLE to the database owner', async () => {
    await owner.query(`CREATE ROLE "${roleName}" NOINHERIT`);
    const administrator = await owner.query<{ name: string }>(
      'SELECT quote_ident(current_user) AS name',
    );
    await owner.query(`GRANT ${administrator.rows[0]!.name} TO "${roleName}"`);
    await provision();
    await expect(runtime!.query(`SET ROLE ${administrator.rows[0]!.name}`)).rejects.toMatchObject({
      code: '42501',
    });
    expect(
      (
        await owner.query(
          'SELECT count(*)::int AS count FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname=$1',
          [roleName],
        )
      ).rows[0]!.count,
    ).toBe(0);
  });
  it('refuses a preexisting role that owns objects instead of pretending DML grants restrict it', async () => {
    await owner.query(`CREATE ROLE "${roleName}"`);
    await owner.query('CREATE TABLE public.permission_probe(id int)');
    await owner.query(`ALTER TABLE public.permission_probe OWNER TO "${roleName}"`);
    await expect(
      provisionRuntimeRole(owner, decodeURIComponent(new URL(runtimeUrl).password), roleName),
    ).rejects.toThrow('already owns objects');
    const role = await owner.query('SELECT rolcanlogin FROM pg_roles WHERE rolname=$1', [roleName]);
    expect(role.rows[0]!.rolcanlogin).toBe(false);
    await owner.query('DROP TABLE public.permission_probe');
    await provision();
    await expect(
      runtime!.query('CREATE TABLE public.permission_probe(id int)'),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
