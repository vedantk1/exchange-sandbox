import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Exchange } from '../../apps/server/src/exchange.js';
import { provisionRuntimeRole } from '../../apps/server/src/deploy/runtime-role.js';
import { isolatedDatabase } from '../../apps/server/src/operations/database.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

const acceptedTerms = [
  'id',
  'session_id',
  'account_id',
  'side',
  'type',
  'quantity',
  'price',
  'acceptance_sequence',
  'created_at',
] as const;
const executionFields = [
  'status',
  'remaining_quantity',
  'reserved_amount',
  'cancel_reason',
  'updated_at',
] as const;

describe('accepted order terms at the PostgreSQL boundary', () => {
  let context: TestExchange;
  beforeEach(async () => {
    context = await createTestExchange();
  });
  afterEach(async () => context?.dispose());

  async function terminalOrders() {
    const maker = await context.trader('maker');
    const trader = await context.trader('trader');
    const limit = await context.place(trader, 'BUY', '0.1', '45000');
    await context.cancel(trader, limit.order!.id);
    const ask = await context.place(maker, 'SELL', '0.1', '50000');
    const quote = await context.exchange.previewMarket({
      accountId: trader,
      sessionId: context.sessionId,
      side: 'BUY',
      quantity: '0.1',
    });
    await context.cancel(maker, ask.order!.id);
    const market = await context.exchange.placeMarket({
      accountId: trader,
      sessionId: context.sessionId,
      commandId: randomUUID(),
      previewId: quote.previewId,
    });
    expect(market).toMatchObject({
      status: 'ACCEPTED',
      fills: [],
      order: { type: 'MARKET', status: 'CANCELED', reserved: '0.000000000' },
    });
    return { maker, limit: limit.order!.id, market: market.order!.id };
  }

  async function orderEvidence() {
    return (
      await context.sql.query<{ value: string }>(
        'SELECT row_to_json(o)::text AS value FROM orders o ORDER BY id',
      )
    ).rows;
  }

  it('rejects otherwise-valid changes to every accepted term for LIMIT and MARKET orders', async () => {
    const orders = await terminalOrders();
    const otherSession = randomUUID();
    await context.sql.query(
      `INSERT INTO exchange_sessions (id, state, created_at, closed_at)
       VALUES ($1, 'CLOSED', clock_timestamp(), clock_timestamp())`,
      [otherSession],
    );
    const changes: Record<(typeof acceptedTerms)[number], { expression: string; value?: string }> =
      {
        id: { expression: '$2', value: randomUUID() },
        session_id: { expression: '$2', value: otherSession },
        account_id: { expression: '$2', value: orders.maker },
        side: { expression: "CASE side WHEN 'BUY' THEN 'SELL' ELSE 'BUY' END" },
        type: { expression: "CASE type WHEN 'LIMIT' THEN 'MARKET' ELSE 'LIMIT' END" },
        quantity: { expression: 'quantity + 1' },
        price: { expression: 'price + 1' },
        acceptance_sequence: { expression: 'acceptance_sequence + 1000000' },
        created_at: { expression: "created_at + interval '1 microsecond'" },
      };
    const before = await orderEvidence();
    const client = await context.sql.connect();
    try {
      for (const id of [orders.limit, orders.market]) {
        for (const field of acceptedTerms) {
          const change = changes[field];
          // Only identifiers and expressions in the constant test allowlist enter SQL.
          const statement = `UPDATE orders SET ${field} = ${change.expression} WHERE id = $1`;
          const parameters = change.value ? [id, change.value] : [id];
          await client.query('BEGIN');
          try {
            if (field === 'session_id') {
              // Isolate the new guard from the existing archived-session guard.
              // DDL and all edits below are rolled back in this disposable schema.
              await client.query('ALTER TABLE orders DISABLE TRIGGER active_order_session');
            }
            await expect(client.query(statement, parameters)).rejects.toMatchObject({
              code: '23514',
              message: 'Accepted order identity and terms are immutable',
            });
          } finally {
            await client.query('ROLLBACK');
          }
          // Prove each proposed change satisfies other checks/FKs: removing only
          // the new guard allows the same UPDATE, without persisting corruption.
          await client.query('BEGIN');
          try {
            await client.query('ALTER TABLE orders DISABLE TRIGGER immutable_order_terms');
            if (field === 'session_id')
              await client.query('ALTER TABLE orders DISABLE TRIGGER active_order_session');
            expect((await client.query(statement, parameters)).rowCount).toBe(1);
          } finally {
            await client.query('ROLLBACK');
          }
        }
        expect(
          (
            await client.query(
              `UPDATE orders SET ${acceptedTerms.map((field) => `${field} = ${field}`).join(', ')} WHERE id = $1`,
              [id],
            )
          ).rowCount,
        ).toBe(1);
      }
    } finally {
      client.release();
    }
    expect(await orderEvidence()).toEqual(before);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('prevents deletion of open, partially filled, filled, and canceled order evidence', async () => {
    const terminal = await terminalOrders();
    const trader = await context.trader('buyer');
    const open = await context.place(trader, 'BUY', '0.1', '40000');
    const ask = await context.place(terminal.maker, 'SELL', '0.3', '50000');
    const filled = await context.place(trader, 'BUY', '0.1', '50000');
    const quote = await context.exchange.previewMarket({
      accountId: trader,
      sessionId: context.sessionId,
      side: 'BUY',
      quantity: '0.1',
    });
    const market = await context.exchange.placeMarket({
      accountId: trader,
      sessionId: context.sessionId,
      commandId: randomUUID(),
      previewId: quote.previewId,
    });
    expect(market.order).toMatchObject({ type: 'MARKET', status: 'FILLED' });
    expect((await context.exchange.snapshot(terminal.maker)).orders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: ask.order!.id, status: 'PARTIALLY_FILLED' }),
      ]),
    );
    const before = await orderEvidence();
    for (const id of [
      open.order!.id,
      ask.order!.id,
      filled.order!.id,
      terminal.limit,
      terminal.market,
      market.order!.id,
    ]) {
      await expect(
        context.sql.query('DELETE FROM orders WHERE id = $1', [id]),
      ).rejects.toMatchObject({
        code: '23514',
        message: 'Orders cannot be deleted or truncated',
      });
    }
    await expect(context.sql.query('TRUNCATE orders CASCADE')).rejects.toMatchObject({
      code: '23514',
      message: 'Orders cannot be deleted or truncated',
    });
    expect(await orderEvidence()).toEqual(before);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('rolls back a multirow UPDATE and earlier mutable changes in a failed transaction', async () => {
    const orders = await terminalOrders();
    const before = await orderEvidence();
    await expect(
      context.sql.query(
        `UPDATE orders SET cancel_reason = 'PROBE',
          price = CASE WHEN id = $1 THEN price + 1 ELSE price END
         WHERE id IN ($1, $2)`,
        [orders.market, orders.limit],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(await orderEvidence()).toEqual(before);
    const client = await context.sql.connect();
    try {
      await client.query('BEGIN');
      expect(
        (
          await client.query("UPDATE orders SET cancel_reason = 'PROBE' WHERE id = $1", [
            orders.limit,
          ])
        ).rowCount,
      ).toBe(1);
      await expect(
        client.query('UPDATE orders SET quantity = quantity + 1 WHERE id = $1', [orders.market]),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await orderEvidence()).toEqual(before);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});

describe('order integrity with the restricted self-host runtime role', () => {
  let database: Awaited<ReturnType<typeof isolatedDatabase>>;
  let owner: pg.Client;
  let runtime: pg.Client;
  let exchange: Exchange | undefined;
  let roleName: string;
  let runtimeUrl: string;
  let sessionId: string;
  let seller: string;
  let buyer: string;

  beforeEach(async () => {
    database = await isolatedDatabase(process.env.TEST_DATABASE_URL!);
    owner = new pg.Client({ connectionString: database.url });
    await owner.connect();
    const migration = await Exchange.open(database.url);
    await migration.close();
    roleName = `order_runtime_${randomUUID().replaceAll('-', '')}`;
    const url = new URL(database.url);
    url.username = roleName;
    url.password = randomBytes(32).toString('hex');
    runtimeUrl = url.toString();
    await provisionRuntimeRole(owner, decodeURIComponent(url.password), roleName);
    runtime = new pg.Client({ connectionString: runtimeUrl });
    await runtime.connect();
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    sessionId = (await exchange.bootstrap()).sessionId;
    seller = randomUUID();
    buyer = randomUUID();
    await exchange.createTrader({ accountId: seller, label: 'seller', commandId: randomUUID() });
    await exchange.createTrader({ accountId: buyer, label: 'buyer', commandId: randomUUID() });
  });
  afterEach(async () => {
    await exchange?.close();
    exchange = undefined;
    await runtime?.end();
    await owner.query(`DROP OWNED BY "${roleName}"`).catch(() => undefined);
    await owner.query(`DROP ROLE IF EXISTS "${roleName}"`);
    await owner.end();
    await database.dispose();
  });

  it('removes inherited table/column/PUBLIC grants and allows updates only to execution fields', async () => {
    const ask = await exchange!.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      side: 'SELL',
      quantity: '0.2',
      price: '50000',
    });
    await owner.query(`GRANT UPDATE, DELETE ON orders TO ${roleName}`);
    await owner.query(`GRANT UPDATE (id, price) ON orders TO ${roleName}`);
    await owner.query('GRANT UPDATE (account_id) ON orders TO PUBLIC');
    await owner.query('GRANT TRUNCATE ON orders TO PUBLIC');
    await provisionRuntimeRole(owner, decodeURIComponent(new URL(runtimeUrl).password), roleName);
    for (const field of acceptedTerms) {
      await expect(
        runtime.query(`UPDATE orders SET ${field} = ${field} WHERE id = $1`, [ask.order!.id]),
      ).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      runtime.query('DELETE FROM orders WHERE id = $1', [ask.order!.id]),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(runtime.query('TRUNCATE orders CASCADE')).rejects.toMatchObject({ code: '42501' });
    expect(
      (
        await runtime.query(
          `UPDATE orders SET ${executionFields.map((field) => `${field} = ${field}`).join(', ')} WHERE id = $1`,
          [ask.order!.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await runtime.query<{
          table_update: boolean;
          table_delete: boolean;
          table_truncate: boolean;
        }>(
          `SELECT has_table_privilege(current_user, 'orders', 'UPDATE') AS table_update,
            has_table_privilege(current_user, 'orders', 'DELETE') AS table_delete,
            has_table_privilege(current_user, 'orders', 'TRUNCATE') AS table_truncate`,
        )
      ).rows,
    ).toEqual([{ table_update: false, table_delete: false, table_truncate: false }]);
    expect(await exchange!.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('preserves partial fills, market guard cancellation, exact release and lost-acknowledgement recovery', async () => {
    const limit = await exchange!.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      side: 'SELL',
      quantity: '0.3',
      price: '50000',
    });
    const buyInput = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    const buy = await exchange!.placeLimit(buyInput);
    expect(buy.order?.status).toBe('FILLED');
    expect((await exchange!.snapshot(seller)).orders[0]).toMatchObject({
      id: limit.order!.id,
      status: 'PARTIALLY_FILLED',
      remaining: '0.2000',
      reserved: '0.2000',
    });
    const outside = await exchange!.placeLimit({
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      side: 'SELL',
      quantity: '0.1',
      price: '53000',
    });
    const quote = await exchange!.previewMarket({
      accountId: buyer,
      sessionId,
      side: 'BUY',
      quantity: '0.3',
    });
    const marketInput = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId,
      previewId: quote.previewId,
    };
    await exchange!.close();
    exchange = await Exchange.open(runtimeUrl, {
      migrations: 'verify',
      hooks: {
        afterCommit: async (id) => {
          if (id === marketInput.commandId) throw new Error('Lost acknowledgement');
        },
      },
    });
    await expect(exchange.placeMarket(marketInput)).rejects.toThrow('Lost acknowledgement');
    const committed = await exchange.getReceipt(buyer, marketInput.commandId);
    expect(committed).toMatchObject({
      status: 'ACCEPTED',
      order: {
        type: 'MARKET',
        status: 'CANCELED',
        remaining: '0.1000',
        reserved: '0.000000000',
        cancelReason: 'PRICE_GUARD_REACHED',
      },
    });
    expect(committed!.fills).toHaveLength(1);
    await exchange.close();
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    expect(await exchange.placeMarket(marketInput)).toEqual(committed);
    expect(await exchange.placeLimit(buyInput)).toEqual(buy);
    const cancelInput = {
      accountId: seller,
      commandId: randomUUID(),
      sessionId,
      orderId: outside.order!.id,
    };
    const cancellation = await exchange.cancel(cancelInput);
    expect(cancellation.order).toMatchObject({
      status: 'CANCELED',
      remaining: '0.1000',
      reserved: '0.0000',
      cancelReason: 'USER_REQUEST',
    });
    await exchange.close();
    exchange = await Exchange.open(runtimeUrl, { migrations: 'verify' });
    expect(await exchange.cancel(cancelInput)).toEqual(cancellation);
    expect((await exchange.snapshot(buyer)).balances['USD-SIM'].total).toBe('84985.000000000');
    expect((await exchange.snapshot(seller)).balances['BTC-SIM'].reserved).toBe('0.0000');
    expect((await runtime.query('SELECT id FROM orders')).rowCount).toBe(4);
    expect((await runtime.query('SELECT id FROM fills')).rowCount).toBe(2);
    expect(await exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});
