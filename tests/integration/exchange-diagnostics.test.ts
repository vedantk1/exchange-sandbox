import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Diagnostics } from '../../apps/server/src/diagnostics.js';
import { Exchange, RecoveryError } from '../../apps/server/src/exchange.js';
import { createTestExchange, type TestExchange } from '../helpers/database.js';

interface RecordedEvent {
  event: string;
  requestId?: string;
  commandId?: string;
  sessionId?: string;
  sequence?: string;
  operation?: string;
  outcome?: string;
}

function recording() {
  const events: RecordedEvent[] = [];
  const diagnostics = new Diagnostics({ sink: (event) => events.push(event) });
  return { diagnostics, events };
}

describe('exchange diagnostics at durable financial boundaries', () => {
  let context: TestExchange | undefined;

  afterEach(async () => {
    const previous = context;
    context = undefined;
    await previous?.dispose();
  });

  it('correlates committed, rejected, and replayed commands without recording financial payloads', async () => {
    const { diagnostics, events } = recording();
    context = await createTestExchange({ diagnostics });
    const trader = await context.trader('private actor label');
    const input = {
      accountId: trader,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL' as const,
      quantity: '0.1',
      price: '50000',
    };
    const requestId = randomUUID();
    const accepted = await diagnostics.run({ requestId }, () =>
      context!.exchange.placeLimit(input),
    );
    expect(await context.exchange.getReceipt(trader, input.commandId)).toEqual(accepted);
    expect(await context.exchange.placeLimit(input)).toEqual(accepted);
    const rejected = await context.exchange.placeLimit({
      ...input,
      commandId: randomUUID(),
      quantity: '2',
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', code: 'INSUFFICIENT_FUNDS' });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: 'command.completed',
          requestId,
          commandId: input.commandId,
          sessionId: context.sessionId,
          sequence: accepted.sequence,
          operation: 'limit_order',
          outcome: 'accepted',
        }),
        expect.objectContaining({
          event: 'command.replayed',
          commandId: input.commandId,
          sequence: accepted.sequence,
          outcome: 'accepted',
        }),
        expect.objectContaining({
          event: 'command.completed',
          commandId: rejected.commandId,
          sequence: rejected.sequence,
          outcome: 'rejected',
        }),
      ]),
    );
    const timing = diagnostics.snapshot().timings['engine.command'];
    expect(timing?.count).toBe(3);
    expect(timing?.outcomes.accepted).toBe(2);
    expect(timing?.outcomes.rejected).toBe(1);
    const serialized = JSON.stringify({ events, snapshot: diagnostics.snapshot() });
    for (const privateValue of [trader, 'private actor label', 'quantity', 'price', 'payload_hash'])
      expect(serialized).not.toContain(privateValue);
    expect((await context.exchange.snapshot(trader)).orders).toHaveLength(1);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('distinguishes rolled-back work from a committed command whose reply is lost', async () => {
    const { diagnostics, events } = recording();
    const rolledBack = randomUUID();
    const lostReply = randomUUID();
    const privateFailure = 'private injected token must never enter diagnostics';
    context = await createTestExchange({
      diagnostics,
      hooks: {
        beforeCommit: async (id) => {
          if (id === rolledBack) throw new Error(privateFailure);
        },
        afterCommit: async (id) => {
          if (id === lostReply) {
            expect(events).toContainEqual(
              expect.objectContaining({
                event: 'command.completed',
                commandId: id,
                outcome: 'accepted',
              }),
            );
            throw new Error(privateFailure);
          }
        },
      },
    });
    const trader = await context.trader('trader');
    const input = {
      accountId: trader,
      commandId: rolledBack,
      sessionId: context.sessionId,
      side: 'SELL' as const,
      quantity: '0.1',
      price: '50000',
    };
    await expect(context.exchange.placeLimit(input)).rejects.toThrow(privateFailure);
    expect(await context.exchange.getReceipt(trader, rolledBack)).toBeNull();
    await expect(context.exchange.placeLimit({ ...input, commandId: lostReply })).rejects.toThrow(
      privateFailure,
    );
    const committed = await context.exchange.getReceipt(trader, lostReply);
    expect(committed).toMatchObject({ status: 'ACCEPTED' });
    expect(await context.exchange.placeLimit({ ...input, commandId: lostReply })).toEqual(
      committed,
    );
    expect(
      events.filter(
        (event) => event.event === 'command.completed' && event.commandId === rolledBack,
      ),
    ).toEqual([expect.objectContaining({ outcome: 'error' })]);
    expect(
      events.filter(
        (event) => event.event === 'command.completed' && event.commandId === lostReply,
      ),
    ).toEqual([
      expect.objectContaining({ outcome: 'accepted', sequence: committed!.sequence }),
      expect.objectContaining({ outcome: 'accepted', sequence: committed!.sequence }),
    ]);
    expect(JSON.stringify({ events, snapshot: diagnostics.snapshot() })).not.toContain(
      privateFailure,
    );
    expect((await context.exchange.snapshot(trader)).orders).toHaveLength(1);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('measures the actual serialized lock wait and classifies a lock timeout without writing a receipt', async () => {
    const { diagnostics, events } = recording();
    context = await createTestExchange({ diagnostics });
    const trader = await context.trader('trader');
    const blocker = await context.sql.connect();
    const input = {
      accountId: trader,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'SELL' as const,
      quantity: '0.1',
      price: '50000',
    };
    const before = diagnostics.snapshot().timings['engine.lock']!.count;
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM exchange_control WHERE id = 1 FOR UPDATE');
    try {
      await expect(context.exchange.placeLimit(input)).rejects.toMatchObject({ code: '55P03' });
      const lock = diagnostics.snapshot().timings['engine.lock'];
      expect(lock?.count).toBe(before + 1);
      expect(lock?.outcomes.lock_timeout).toBe(1);
      expect(lock!.maxMs).toBeGreaterThanOrEqual(1_500);
      expect(
        diagnostics.snapshot().timings['database.command.query']?.outcomes.lock_timeout,
      ).toBeGreaterThanOrEqual(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          event: 'command.completed',
          commandId: input.commandId,
          outcome: 'lock_timeout',
        }),
      );
      expect(await context.exchange.getReceipt(trader, input.commandId)).toBeNull();
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(await context.exchange.placeLimit(input)).toMatchObject({ status: 'ACCEPTED' });
    expect(context.exchange.getRuntimeFault()).toBeNull();
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('reports a latched invariant failure and clears its gauge only at the matching recovery revision', async () => {
    const { diagnostics, events } = recording();
    context = await createTestExchange({ diagnostics });
    expect(events).toContainEqual(expect.objectContaining({ event: 'recovery.started' }));
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'recovery.completed', outcome: 'ok' }),
    );
    await expect(
      context.exchange.financialTransaction(async () => {
        throw new RecoveryError('private invariant detail');
      }),
    ).rejects.toBeInstanceOf(RecoveryError);
    const revision = context.exchange.getRuntimeFaultRevision();
    expect(diagnostics.snapshot().gauges['engine.faulted']).toBe(1);
    expect(events.filter((event) => event.event === 'runtime.halted')).toHaveLength(1);
    context.exchange.clearRuntimeFault(revision - 1);
    expect(diagnostics.snapshot().gauges['engine.faulted']).toBe(1);
    await context.exchange.recoveryTransaction(async (tx) => {
      await tx.updateTable('exchange_control').set({ fault: null }).where('id', '=', 1).execute();
    });
    context.exchange.clearRuntimeFault(revision);
    expect(diagnostics.snapshot().gauges['engine.faulted']).toBe(0);
    expect(diagnostics.snapshot().gauges['engine.recovering']).toBe(0);
    expect(JSON.stringify(events)).not.toContain('private invariant detail');
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('keeps telemetry failures outside matching, exact accounting, and receipt recovery', async () => {
    let failures = 0;
    const diagnostics = new Diagnostics({
      sink: () => {
        failures += 1;
        throw new Error('private sink failure');
      },
    });
    context = await createTestExchange({
      diagnostics,
      database: {
        observer: async () => {
          throw new Error('private observer failure');
        },
      },
    });
    const seller = await context.trader('seller');
    const buyer = await context.trader('buyer');
    await context.place(seller, 'SELL', '0.4', '50000');
    const command = {
      accountId: buyer,
      commandId: randomUUID(),
      sessionId: context.sessionId,
      side: 'BUY' as const,
      quantity: '0.1',
      price: '50000',
    };
    const accepted = await context.exchange.placeLimit(command);
    expect(accepted).toMatchObject({ status: 'ACCEPTED', order: { status: 'FILLED' } });
    expect(await context.exchange.placeLimit(command)).toEqual(accepted);
    expect((await context.exchange.snapshot(buyer)).balances['USD-SIM'].total).toBe(
      '94995.000000000',
    );
    expect((await context.exchange.snapshot(context.feeAccountId)).balances['USD-SIM'].total).toBe(
      '10.000000000',
    );
    expect(failures).toBeGreaterThan(0);
    expect(await context.exchange.reconcile()).toEqual({ ok: true, issues: [] });
  });

  it('reports a competing writer without changing the current writer or exposing database details', async () => {
    context = await createTestExchange();
    const { diagnostics, events } = recording();
    await expect(Exchange.open(context.url, { diagnostics })).rejects.toMatchObject({
      code: 'WRITER_UNAVAILABLE',
    });
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'writer.unavailable', outcome: 'unavailable' }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event: 'recovery.completed', outcome: 'unavailable' }),
    );
    expect(diagnostics.snapshot().gauges['engine.available']).toBe(0);
    expect(diagnostics.snapshot().gauges['engine.recovering']).toBe(0);
    expect(JSON.stringify({ events, snapshot: diagnostics.snapshot() })).not.toContain(context.url);
    expect(await context.trader('still available')).toBeTypeOf('string');
  });
});
