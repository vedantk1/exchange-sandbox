import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestExchange, type TestExchange } from '../helpers/database.js';
import { killAtTransactionBoundary } from '../helpers/crash.js';

describe('actual process loss and PostgreSQL recovery', () => {
  let context: TestExchange;

  async function persistedCounts() {
    const result = await context.sql.query<Record<string, number>>(`
      SELECT
        (SELECT count(*)::integer FROM orders) AS orders,
        (SELECT count(*)::integer FROM fills) AS fills,
        (SELECT count(*)::integer FROM journal_transactions) AS journal_transactions,
        (SELECT count(*)::integer FROM journal_entries) AS journal_entries,
        (SELECT count(*)::integer FROM receipts) AS receipts,
        (SELECT count(*)::integer FROM outbox) AS outbox
    `);
    return result.rows[0]!;
  }

  beforeEach(async () => {
    context = await createTestExchange();
  });

  afterEach(async () => {
    await context?.dispose();
  });

  it.each(['beforeCommit', 'afterCommit'] as const)(
    'recovers after SIGKILL at %s without duplicating execution or accounting',
    async (stage) => {
      const seller = await context.trader('seller');
      const buyer = await context.trader('buyer');
      const ask = await context.place(seller, 'SELL', '0.4', '50000');
      const beforeSeller = await context.exchange.snapshot(seller);
      const beforeBuyer = await context.exchange.snapshot(buyer);
      const beforeCounts = await persistedCounts();
      const command = {
        accountId: buyer,
        commandId: randomUUID(),
        sessionId: context.sessionId,
        side: 'BUY' as const,
        quantity: '0.1',
        price: '50000',
      };
      await context.stop();
      await killAtTransactionBoundary(context.url, stage, command);
      await context.start();

      const recoveredReceipt = await context.exchange.getReceipt(buyer, command.commandId);
      if (stage === 'beforeCommit') {
        expect(recoveredReceipt).toBeNull();
        expect(await context.exchange.snapshot(seller)).toEqual(beforeSeller);
        expect(await context.exchange.snapshot(buyer)).toEqual(beforeBuyer);
        expect(await persistedCounts()).toEqual(beforeCounts);
      } else {
        expect(recoveredReceipt).toMatchObject({ status: 'ACCEPTED', order: { status: 'FILLED' } });
        expect((await context.exchange.snapshot(buyer)).fills).toHaveLength(1);
        const recoveredCounts = await persistedCounts();
        expect(recoveredCounts.receipts).toBe(beforeCounts.receipts! + 1);
        expect(recoveredCounts.outbox).toBeGreaterThan(beforeCounts.outbox!);
      }

      const resolved = await context.exchange.placeLimit(command);
      if (stage === 'afterCommit') expect(resolved).toEqual(recoveredReceipt);
      const resolvedCounts = await persistedCounts();
      expect(await context.exchange.placeLimit(command)).toEqual(resolved);
      expect(await persistedCounts()).toEqual(resolvedCounts);
      expect((await context.exchange.snapshot(buyer)).orders).toHaveLength(1);
      expect((await context.exchange.snapshot(buyer)).fills).toHaveLength(1);
      expect((await context.exchange.snapshot(buyer)).balances['USD-SIM'].total).toBe(
        '94995.000000000',
      );
      expect(
        (await context.exchange.snapshot(seller)).orders.find(
          (order) => order.id === ask.order!.id,
        ),
      ).toMatchObject({ status: 'PARTIALLY_FILLED', remaining: '0.3000', reserved: '0.3000' });
      expect(
        (await context.exchange.snapshot(context.feeAccountId)).balances['USD-SIM'].total,
      ).toBe('10.000000000');
      expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
    },
  );
});
