import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

describe('PostgreSQL command admission timestamps', () => {
  let context: TestExchange;

  beforeEach(async () => {
    context = await createTestExchange();
  });

  afterEach(async () => context?.dispose());

  it('timestamps a queued match after admission and preserves evidence and priority across replay and restart', async () => {
    const maker = await context.trader('maker');
    const taker = await context.trader('taker');
    const worse = await context.place(maker, 'SELL', '0.1', '50010');
    const first = await context.place(maker, 'SELL', '0.1', '50000');
    const second = await context.place(maker, 'SELL', '0.1', '50000');
    const command = {
      accountId: taker,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY' as const,
      quantity: '0.25',
      price: '50100',
    };
    const holder = await context.sql.connect();
    await holder.query('BEGIN');
    const { rows: holderRows } = await holder.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid',
    );
    await holder.query('SELECT id FROM exchange_control WHERE id = 1 FOR UPDATE');
    // Observe the real database transaction waiting on the same admission lock
    // as HTTP commands. A whole-second boundary demonstrates the old clock
    // semantics without waiting for an entire candle minute in every CI run.
    const pending = context.exchange.placeLimit(command).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    let boundary: string | undefined;
    try {
      const deadline = performance.now() + 1_000;
      while (performance.now() < deadline) {
        const waiting = await context.sql.query<{ boundary: string }>(
          `SELECT (date_trunc('second', xact_start) + interval '1 second')::text AS boundary
            FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
            AND wait_event_type = 'Lock' AND query ILIKE '%exchange_control%'`,
          [holderRows[0]!.pid],
        );
        boundary = waiting.rows[0]?.boundary;
        if (boundary) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(boundary).toBeDefined();
      await holder.query(
        `SELECT pg_sleep(GREATEST(0,
          EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp()))) + 0.03)`,
        [boundary],
      );
      const release = await holder.query<{ released_at: string }>(
        'SELECT clock_timestamp()::text AS released_at',
      );
      await holder.query('COMMIT');
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      const result = outcome.result;
      expect(result.fills.map(({ makerOrderId }) => makerOrderId)).toEqual([
        first.order!.id,
        second.order!.id,
        worse.order!.id,
      ]);

      async function evidence() {
        return context.sql.query<{ source: string; timestamp: string }>(
          `SELECT 'order-created' AS source, created_at::text AS timestamp FROM orders WHERE id=$1
          UNION ALL SELECT 'order-updated', updated_at::text FROM orders WHERE id=ANY($2::uuid[])
          UNION ALL SELECT 'fill', created_at::text FROM fills WHERE taker_order_id=$1
          UNION ALL SELECT 'journal', created_at::text FROM journal_transactions WHERE command_id=$3
          UNION ALL SELECT 'receipt', created_at::text FROM receipts WHERE actor_id=$4 AND command_id=$3
          UNION ALL SELECT 'outbox', created_at::text FROM outbox WHERE session_id=$5 AND sequence=$6
          ORDER BY source, timestamp`,
          [
            result.order!.id,
            [result.order!.id, first.order!.id, second.order!.id, worse.order!.id],
            command.commandId,
            taker,
            context.sessionId,
            result.sequence,
          ],
        );
      }
      const original = await evidence();
      expect(original.rows).toHaveLength(11);
      expect(new Set(original.rows.map(({ timestamp }) => timestamp)).size).toBe(1);
      const { rows } = await context.sql.query<{ after_release: boolean; next_second: boolean }>(
        `SELECT $1::timestamptz >= $2::timestamptz AS after_release,
          date_trunc('second', $1::timestamptz) >= $3::timestamptz AS next_second`,
        [original.rows[0]!.timestamp, release.rows[0]!.released_at, boundary],
      );
      expect(rows).toEqual([{ after_release: true, next_second: true }]);
      expect(await context.exchange.placeLimit(command)).toEqual(result);
      expect((await evidence()).rows).toEqual(original.rows);
      await context.start();
      expect(await context.exchange.getReceipt(taker, command.commandId)).toEqual(result);
      expect(await context.exchange.placeLimit(command)).toEqual(result);
      expect((await evidence()).rows).toEqual(original.rows);
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
      await pending;
    }
  });

  it('captures a fresh cancellation timestamp shared by the order, release journal, receipt, and event', async () => {
    const trader = await context.trader('trader');
    const placed = await context.place(trader, 'BUY', '0.1', '50000');
    const cancel = {
      accountId: trader,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      orderId: placed.order!.id,
    };
    const canceled = await context.exchange.cancel(cancel);
    const timestamps = await context.sql.query<{ coherent: boolean; later: boolean }>(
      `SELECT o.updated_at = j.created_at AND o.updated_at = r.created_at
        AND o.updated_at = e.created_at AS coherent,
        o.updated_at > o.created_at AS later
        FROM orders o JOIN journal_transactions j ON j.command_id=$2
        JOIN receipts r ON r.actor_id=$3 AND r.command_id=$2
        JOIN outbox e ON e.session_id=$4 AND e.sequence=$5 WHERE o.id=$1`,
      [cancel.orderId, cancel.commandId, trader, context.sessionId, canceled.sequence],
    );
    expect(timestamps.rows).toEqual([{ coherent: true, later: true }]);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });
});
