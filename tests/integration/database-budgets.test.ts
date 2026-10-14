import { randomUUID } from 'node:crypto';
import { createServer, connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createDatabase,
  withDatabaseBudget,
  type DatabaseBudgets,
} from '../../packages/database/src/index.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';
import { Exchange } from '../../apps/server/src/exchange.js';

const budgets: DatabaseBudgets = {
  read: { statementMs: 100, totalMs: 500 },
  command: { statementMs: 700, totalMs: 1_200 },
  maintenance: { statementMs: 2_000, totalMs: 3_000 },
};

function sleep(database: ReturnType<typeof createDatabase>, seconds: number) {
  return database
    .selectNoFrom((expression) =>
      expression.fn<void>('pg_sleep', [expression.val(seconds)]).as('wait'),
    )
    .execute();
}

function selectValue(database: ReturnType<typeof createDatabase>, value: number) {
  return database.selectNoFrom((expression) => expression.val(value).as('value')).execute();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('bounded PostgreSQL work and transport disposal', () => {
  let context: TestExchange | undefined;
  afterEach(async () => {
    const previous = context;
    context = undefined;
    await previous?.dispose();
  });

  it('limits slow reads and blocked table reads without latching an accounting fault', async () => {
    context = await createTestExchange({ database: { budgets } });
    await expect(context.exchange.readTransaction((tx) => sleep(tx, 1))).rejects.toMatchObject({
      code: '57014',
    });
    const blocker = await context.sql.connect();
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE orders IN ACCESS EXCLUSIVE MODE');
    try {
      await expect(
        context.exchange.readTransaction((tx) => tx.selectFrom('orders').select('id').execute()),
      ).rejects.toSatisfy((error: { code: string }) => ['57014', '55P03'].includes(error.code));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(context.exchange.getRuntimeFault()).toBeNull();
    expect((await context.exchange.reconcile()).ok).toBe(true);
    expect(await context.trader('healthy-after-cancel')).toBeTypeOf('string');
  });

  it('applies distinct command and maintenance budgets and resets them on reused connections', async () => {
    context = await createTestExchange({ database: { max: 1, budgets } });
    await context.exchange.financialTransaction(async (tx) => {
      await sleep(tx, 0.2);
    });
    await expect(
      context.exchange.financialTransaction(async (tx) => {
        await sleep(tx, 1);
      }),
    ).rejects.toMatchObject({ code: '57014' });
    await context.exchange.recoveryTransaction(async (tx) => {
      await sleep(tx, 0.9);
    });
    await expect(context.exchange.readTransaction((tx) => sleep(tx, 0.2))).rejects.toMatchObject({
      code: '57014',
    });
    expect(context.exchange.getRuntimeFault()).toBeNull();
  });

  it('preserves a typed timeout when PostgreSQL terminates the transaction before the local deadline', async () => {
    context = await createTestExchange({ database: { max: 1, budgets } });
    await expect(
      context.exchange.readTransaction(async (tx) => {
        await tx
          .selectNoFrom((expression) =>
            expression
              .fn<string>('set_config', [
                expression.val('statement_timeout'),
                expression.val('1000ms'),
                expression.val(true),
              ])
              .as('configured'),
          )
          .execute();
        await sleep(tx, 0.7);
      }),
    ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    expect(context.exchange.getRuntimeFault()).toBeNull();
    expect(await context.exchange.readTransaction((tx) => selectValue(tx, 1))).toEqual([
      { value: '1' },
    ]);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('bounds pool acquisition and discards an expired paused transaction before any late writes', async () => {
    context = await createTestExchange({ database: { max: 1, budgets, acquireTimeoutMs: 80 } });
    const entered = deferred();
    const release = deferred();
    let lateFailure: unknown;
    const paused = context.exchange.readTransaction(async (tx) => {
      await selectValue(tx, 1);
      entered.resolve();
      await release.promise;
      try {
        await selectValue(tx, 1);
      } catch (error) {
        lateFailure = error;
        throw error;
      }
    });
    const outcome = expect(paused).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    await entered.promise;
    await expect(
      context.exchange.readTransaction((tx) => selectValue(tx, 1)),
    ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    await outcome;
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(lateFailure).toMatchObject({ code: 'DATABASE_TIMEOUT' });
    expect(await context.exchange.readTransaction((tx) => selectValue(tx, 1))).toMatchObject([
      { value: '1' },
    ]);
  });

  it('rolls back an admitted command whose callback exceeds its total budget and recovers the original identity', async () => {
    context = await createTestExchange();
    const trader = await context.trader('trader');
    const before = await context.exchange.snapshot(trader);
    const release = deferred();
    const command = {
      accountId: trader,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    await context.start({
      database: { budgets: { ...budgets, command: { statementMs: 300, totalMs: 500 } } },
      hooks: { beforeCommit: async () => release.promise },
    });
    await expect(context.exchange.placeLimit(command)).rejects.toMatchObject({
      code: 'DATABASE_TIMEOUT',
    });
    expect(await context.exchange.getReceipt(trader, command.commandId)).toBeNull();
    release.resolve();
    await context.start();
    expect(await context.exchange.snapshot(trader)).toEqual(before);
    const recovered = await context.exchange.placeLimit(command);
    expect(await context.exchange.placeLimit(command)).toEqual(recovered);
    expect((await context.exchange.snapshot(trader)).orders).toHaveLength(1);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('drains shutdown once, forcibly closes paused work, and preserves writer ownership until transports end', async () => {
    context = await createTestExchange({ database: { budgets, closeTimeoutMs: 100 } });
    const entered = deferred();
    const release = deferred();
    const work = context.exchange.accessTransaction(async (tx) => {
      entered.resolve();
      await release.promise;
      await tx
        .updateTable('exchange_control')
        .set({ next_sequence: '999999' })
        .where('id', '=', 1)
        .execute();
    });
    const outcome = expect(work).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    await entered.promise;
    await Promise.all([context.exchange.close(), context.exchange.close()]);
    release.resolve();
    await outcome;
    await context.start();
    expect(
      (await context.sql.query('SELECT next_sequence FROM exchange_control')).rows[0].next_sequence,
    ).not.toBe('999999');
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('destroys a stalled transport before returning its connection to the pool', async () => {
    context = await createTestExchange();
    const source = new URL(context.url);
    const sockets = new Set<Socket>();
    let paused = false;
    const proxy = createServer((incoming) => {
      const upstream = connect({ host: source.hostname, port: Number(source.port) });
      for (const socket of [incoming, upstream]) {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => {
          sockets.delete(socket);
          incoming.destroy();
          upstream.destroy();
        });
      }
      incoming.pipe(upstream);
      upstream.on('data', (data: Buffer) => {
        if (!paused) incoming.write(data);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy address missing.');
    const proxied = new URL(context.url);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(address.port);
    const database = createDatabase(proxied.toString(), { max: 1, budgets });
    try {
      await withDatabaseBudget(database, 'read', () => selectValue(database, 1));
      paused = true;
      await expect(
        withDatabaseBudget(database, 'read', () => selectValue(database, 2)),
      ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
      paused = false;
      expect(
        await withDatabaseBudget(database, 'read', () => selectValue(database, 3)),
      ).toMatchObject([{ value: '3' }]);
    } finally {
      await database.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('bounds writer guard acquisition if its SQL response is lost after connecting', async () => {
    context = await createTestExchange();
    const source = new URL(context.url);
    const upstreamPort = Number(source.port);
    const sockets = new Set<Socket>();
    const proxy = createServer((incoming) => {
      const upstream = connect({ host: '127.0.0.1', port: upstreamPort });
      let blocked = false;
      for (const socket of [incoming, upstream]) {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.once('close', () => {
          sockets.delete(socket);
          incoming.destroy();
          upstream.destroy();
        });
      }
      incoming.on('data', (data: Buffer) => {
        if (data.includes(Buffer.from('pg_try_advisory_lock'))) blocked = true;
        upstream.write(data);
      });
      upstream.on('data', (data: Buffer) => {
        if (!blocked) incoming.write(data);
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Proxy address missing.');
    source.hostname = '127.0.0.1';
    source.port = String(address.port);
    try {
      await expect(Exchange.open(source.toString())).rejects.toMatchObject({
        code: 'DATABASE_TIMEOUT',
      });
      expect((await context.exchange.reconcile()).ok).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('bounds shutdown while an initial PostgreSQL handshake is stalled', async () => {
    const sockets = new Set<Socket>();
    const connected = deferred();
    const blackhole = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.once('close', () => sockets.delete(socket));
      connected.resolve();
    });
    await new Promise<void>((resolve) => blackhole.listen(0, '127.0.0.1', resolve));
    const address = blackhole.address();
    if (!address || typeof address === 'string') throw new Error('Blackhole address missing.');
    const database = createDatabase(
      `postgresql://postgres@127.0.0.1:${address.port}/exchange_test`,
      {
        budgets,
        acquireTimeoutMs: 5_000,
        closeTimeoutMs: 100,
      },
    );
    const pending = expect(
      withDatabaseBudget(database, 'read', () => selectValue(database, 1)),
    ).rejects.toMatchObject({ code: 'DATABASE_TIMEOUT' });
    try {
      await connected.promise;
      const started = performance.now();
      await database.destroy();
      // Leave room for a slow runner while distinguishing the old five-second wait.
      expect(performance.now() - started).toBeLessThan(1_500);
      await pending;
    } finally {
      await database.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        blackhole.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
