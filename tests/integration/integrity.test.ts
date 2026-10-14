import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Exchange } from '../../apps/server/src/exchange.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

describe('database integrity boundaries', () => {
  let context: TestExchange;

  beforeEach(async () => {
    context = await createTestExchange();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  it('refuses a second active writer without disrupting the current instance', async () => {
    await expect(Exchange.open(context.url)).rejects.toThrow();
    const trader = await context.trader('trader');
    expect((await context.place(trader, 'BUY', '0.1', '50000')).status).toBe('ACCEPTED');
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('refuses an unknown schema version instead of running against an incompatible database', async () => {
    await context.stop();
    await context.sql.query(
      `INSERT INTO schema_migrations (name, checksum, checksum_origin, verified_at)
        VALUES ($1, repeat('0', 64), 'APPLIED', current_timestamp)`,
      ['999_future_schema'],
    );
    await expect(context.start()).rejects.toThrow('unsupported migration');
  });

  it('rejects a journal that nets to zero overall but is unbalanced for each asset', async () => {
    const trader = await context.trader('trader');
    const client = await context.sql.connect();
    const transactionId = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO journal_transactions (id, session_id, command_id, kind) VALUES ($1, $2, $3, $4)',
        [transactionId, context.sessionId, randomUUID(), 'TEST_UNBALANCED'],
      );
      await client.query(
        `
        INSERT INTO journal_entries (journal_transaction_id, session_id, account_id, asset, bucket, amount)
        VALUES ($1, $2, $3, 'BTC-SIM', 'AVAILABLE', 1), ($1, $2, $3, 'USD-SIM', 'AVAILABLE', -1)
      `,
        [transactionId, context.sessionId, trader],
      );
      await expect(client.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const persisted = await context.sql.query('SELECT id FROM journal_transactions WHERE id = $1', [
      transactionId,
    ]);
    expect(persisted.rows).toEqual([]);
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('makes committed journal, fills, receipts, outbox, and allocations append-only', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.place(seller, 'SELL', '0.1', '50000');
    await context.place(buyer, 'BUY', '0.1', '50000');
    const tables = [
      ['journal_transactions', 'id'],
      ['journal_entries', 'amount'],
      ['fills', 'id'],
      ['receipts', 'command_id'],
      ['outbox', 'event_type'],
      ['allocations', 'command_id'],
    ] as const;
    for (const [table, column] of tables) {
      // Identifiers come only from this constant allowlist, never user input.
      await expect(
        context.sql.query(`UPDATE ${table} SET ${column} = ${column}`),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(context.sql.query(`DELETE FROM ${table}`)).rejects.toMatchObject({
        code: '23514',
      });
    }
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('does not allow more entries to be attached to an already committed journal', async () => {
    const trader = await context.trader('trader');
    const journal = await context.sql.query<{ id: string }>(
      'SELECT id FROM journal_transactions LIMIT 1',
    );
    await expect(
      context.sql.query(
        `
      INSERT INTO journal_entries (journal_transaction_id, session_id, account_id, asset, bucket, amount)
      VALUES ($1, $2, $3, 'BTC-SIM', 'AVAILABLE', 1), ($1, $2, $3, 'BTC-SIM', 'RESERVED', -1)
    `,
        [journal.rows[0]!.id, context.sessionId, trader],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await context.exchange.reconcile()).ok).toBe(true);
  });

  it('rejects negative customer balances at the database boundary', async () => {
    const trader = await context.trader('trader');
    await expect(
      context.sql.query(
        `
      UPDATE balances SET amount = -1
      WHERE session_id = $1 AND account_id = $2 AND asset = 'USD-SIM' AND bucket = 'AVAILABLE'
    `,
        [context.sessionId, trader],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await context.exchange.snapshot(trader)).balances['USD-SIM'].available).toBe(
      '100000.000000000',
    );
  });

  it('rolls back a runtime invariant failure, records its outcome, and blocks queued financial work', async () => {
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    const ask = await context.place(seller, 'SELL', '0.1', '50000');
    const buyerBefore = await context.exchange.snapshot(buyer);
    const journalsBefore = await context.sql.query('SELECT count(*) AS count FROM journal_entries');
    // Owner-only fault injection: the order still holds 0.1, but its projection
    // is corrupt. Attempting a fill must fail rather than create negative funds.
    await context.sql.query(
      `
      UPDATE balances SET amount = 0
      WHERE session_id = $1 AND account_id = $2 AND asset = 'BTC-SIM' AND bucket = 'RESERVED'
    `,
      [context.sessionId, seller],
    );
    const results = await Promise.allSettled([
      context.place(buyer, 'BUY', '0.1', '50000'),
      context.place(buyer, 'BUY', '0.1', '50000'),
    ]);
    const completed = results.filter((result) => result.status === 'fulfilled');
    const blocked = results.filter((result) => result.status === 'rejected');
    expect(completed).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    const outcome = completed[0]!.value;
    expect(outcome).toMatchObject({ status: 'REJECTED', code: 'INVARIANT_FAILURE', fills: [] });
    expect(blocked[0]!.reason).toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(await context.exchange.getReceipt(buyer, outcome.commandId)).toEqual(outcome);
    expect(await context.exchange.snapshot(buyer)).toEqual(buyerBefore);
    expect(
      (await context.exchange.snapshot(seller)).orders.find((order) => order.id === ask.order!.id),
    ).toMatchObject({ status: 'OPEN', remaining: '0.1000', reserved: '0.1000' });
    expect((await context.sql.query('SELECT count(*) AS count FROM journal_entries')).rows).toEqual(
      journalsBefore.rows,
    );
    expect((await context.sql.query('SELECT id FROM fills')).rows).toEqual([]);
    expect(
      (
        await context.sql.query<{ fault: string | null }>(
          'SELECT fault FROM exchange_control WHERE id = 1',
        )
      ).rows[0]!.fault,
    ).toBeTruthy();
    await expect(context.place(buyer, 'BUY', '0.1', '49000')).rejects.toMatchObject({
      code: 'RECOVERY_REQUIRED',
    });
  });

  it('refuses startup when a privileged write has corrupted a balance projection', async () => {
    const trader = await context.trader('trader');
    await context.stop();
    // Deliberate database-owner corruption establishes that startup compares
    // independent persisted evidence instead of simply trusting the projection.
    await context.sql.query(
      `
      UPDATE balances SET amount = amount + 1
      WHERE session_id = $1 AND account_id = $2 AND asset = 'USD-SIM' AND bucket = 'AVAILABLE'
    `,
      [context.sessionId, trader],
    );
    await expect(context.start()).rejects.toThrow();
    const control = await context.sql.query<{ fault: string | null }>(
      'SELECT fault FROM exchange_control WHERE id = 1',
    );
    expect(control.rows[0]!.fault).toBeTruthy();
  });
});
