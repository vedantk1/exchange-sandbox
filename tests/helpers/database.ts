import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { Exchange } from '../../apps/server/src/exchange.js';

/** Every test owns a schema; never truncate or reset an existing database. */
export async function createTestExchange() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) {
    throw new Error('TEST_DATABASE_URL must point to a disposable PostgreSQL database.');
  }

  const schema = `exchange_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set(
    'options',
    `${databaseUrl.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
  );
  const url = databaseUrl.toString();
  const sql = new pg.Pool({ connectionString: url });
  let current: Exchange | undefined;

  async function stop() {
    const previous = current;
    current = undefined;
    if (previous) await previous.close();
  }

  async function start() {
    await stop();
    current = await Exchange.open(url);
    return current;
  }

  async function dispose() {
    try {
      await stop();
    } finally {
      await sql.end();
      try {
        // The generated name cannot contain SQL syntax or name another schema.
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  }

  try {
    const exchange = await start();
    const setup = await exchange.bootstrap();
    return {
      ...setup,
      url,
      sql,
      get exchange() {
        if (!current) throw new Error('The test exchange is stopped.');
        return current;
      },
      start,
      stop,
      dispose,
      async trader(label: string) {
        const accountId = randomUUID();
        await this.exchange.createTrader({ accountId, label, commandId: randomUUID() });
        return accountId;
      },
      async place(accountId: string, side: 'BUY' | 'SELL', quantity: string, price: string) {
        return this.exchange.placeLimit({
          accountId,
          commandId: randomUUID(),
          sessionId: setup.sessionId,
          side,
          quantity,
          price,
        });
      },
      async cancel(accountId: string, orderId: string) {
        return this.exchange.cancel({
          accountId,
          commandId: randomUUID(),
          sessionId: setup.sessionId,
          orderId,
        });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export type TestExchange = Awaited<ReturnType<typeof createTestExchange>>;
