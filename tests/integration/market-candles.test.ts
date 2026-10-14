import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { marketCandleQuery } from '../../apps/server/src/market-candles.js';
import { marketWorkspace } from '../../apps/server/src/workspace.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

const legacyQuery = `SELECT date_trunc('minute', created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS timestamp,
  (array_agg(price ORDER BY sequence, fill_index))[1]::text AS open,
  max(price)::text AS high, min(price)::text AS low,
  (array_agg(price ORDER BY sequence DESC, fill_index DESC))[1]::text AS close,
  sum(quantity)::text AS volume FROM fills WHERE session_id=$1
  GROUP BY date_trunc('minute', created_at AT TIME ZONE 'UTC') ORDER BY timestamp DESC LIMIT 60`;

describe('bounded complete market candles', () => {
  let context: TestExchange;
  let seller: string;
  let buyer: string;

  beforeEach(async () => {
    context = await createTestExchange();
    seller = await context.trader('seller');
    buyer = await context.trader('buyer');
    // The isolated fixture supplies timestamps before ordinary commands insert
    // their evidence. No immutable fills or accounting rows are rewritten.
    await context.sql.query(`CREATE TABLE candle_fixture_clock (value timestamptz NOT NULL);
      INSERT INTO candle_fixture_clock VALUES ('2025-01-01T00:00:00Z');
      CREATE OR REPLACE FUNCTION exchange_command_timestamp() RETURNS timestamptz
      LANGUAGE sql VOLATILE AS $$ SELECT value FROM candle_fixture_clock $$`);
  });

  afterEach(async () => context?.dispose());

  async function clock(value: string) {
    await context.sql.query('UPDATE candle_fixture_clock SET value=$1', [value]);
  }

  async function match(price: string, quantity = '0.0001') {
    expect((await context.place(seller, 'SELL', quantity, price)).status).toBe('ACCEPTED');
    const result = await context.place(buyer, 'BUY', quantity, price);
    expect(result.order?.status).toBe('FILLED');
    return result;
  }

  async function candles(sessionId = context.sessionId) {
    return context.exchange.readTransaction(
      async (tx) => (await marketCandleQuery(sessionId).execute(tx)).rows,
    );
  }

  it('returns no candles for an empty session or a different session', async () => {
    expect(await candles()).toEqual([]);
    await match('50000');
    expect(await candles(randomUUID())).toEqual([]);
    expect(await candles()).toHaveLength(1);
  });

  it('selects the latest60 populated sparse minutes and includes a whole burst beyond the trade window', async () => {
    const base = Date.parse('2025-01-01T00:00:00Z');
    for (let index = 0; index < 65; index += 1) {
      await clock(new Date(base + index * 7 * 60_000 + 12_345).toISOString());
      await match(String(50000 + index));
    }
    const burstTimestamp = new Date(base + 65 * 7 * 60_000).toISOString();
    await clock(burstTimestamp);
    for (let index = 0; index < 125; index += 1) {
      await match(String(49000 + (index % 3)));
    }
    const actual = await candles();
    expect(actual).toEqual((await context.sql.query(legacyQuery, [context.sessionId])).rows);
    expect(actual).toHaveLength(60);
    expect(actual[0]).toMatchObject({
      timestamp: new Date(burstTimestamp),
      open: '4900000',
      high: '4900200',
      low: '4900000',
      close: '4900100',
      volume: '125',
    });
    expect(actual.at(-1)?.timestamp).toEqual(new Date(base + 6 * 7 * 60_000));
    const market = await context.exchange.readTransaction((tx) =>
      marketWorkspace(tx, context.sessionId),
    );
    expect(market.trades).toHaveLength(100);
    expect(market.candles.at(-1)?.volume).toBe('0.0125');
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('uses execution sequence and fill index for open and close when timestamps are equal', async () => {
    await context.place(seller, 'SELL', '0.0001', '50002');
    await context.place(seller, 'SELL', '0.0001', '50001');
    const multiFill = await context.place(buyer, 'BUY', '0.0002', '50002');
    expect(multiFill.fills).toHaveLength(2);
    expect(await candles()).toMatchObject([{ open: '5000100', close: '5000200', volume: '2' }]);
    await match('50000');
    const result = await candles();
    expect(result).toEqual((await context.sql.query(legacyQuery, [context.sessionId])).rows);
    expect(result).toEqual([
      {
        timestamp: new Date('2025-01-01T00:00:00Z'),
        open: '5000100',
        high: '5000200',
        low: '5000000',
        close: '5000000',
        volume: '3',
      },
    ]);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('uses UTC minute boundaries even when PostgreSQL connections have a different timezone', async () => {
    await clock('2025-01-01T23:59:59.999Z');
    await match('50001');
    await clock('2025-01-02T00:00:00.000Z');
    await match('50002');
    const expected = await candles();
    const actual = await context.exchange.readTransaction(async (tx) => {
      await tx
        .selectNoFrom((eb) =>
          eb
            .fn<string>('set_config', [eb.val('TimeZone'), eb.val('Pacific/Chatham'), eb.val(true)])
            .as('timezone'),
        )
        .execute();
      return (await marketCandleQuery(context.sessionId).execute(tx)).rows;
    });
    expect(actual).toEqual(expected);
    expect(actual.map(({ timestamp }) => timestamp.toISOString())).toEqual([
      '2025-01-02T00:00:00.000Z',
      '2025-01-01T23:59:00.000Z',
    ]);
  });
});
