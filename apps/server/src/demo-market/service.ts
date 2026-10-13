import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@sandbox/database';
import { formatPrice, formatQuantity } from '@sandbox/domain';
import type { Selectable, Transaction } from 'kysely';
import { quoteIntents } from './inventory.js';
import type { Control, Exchange } from '../exchange.js';
import type { CancelCommand, LimitCommand } from '../types.js';

type State = Selectable<Database['demo_market']>;
type Planned = { type: 'cancel'; input: CancelCommand } | { type: 'limit'; input: LimitCommand };
const ACTIVE = ['OPEN', 'PARTIALLY_FILLED'] as const;

async function changed(tx: Transaction<Database>, control: Control, sessionId: string) {
  await tx
    .updateTable('exchange_control')
    .set({
      next_sequence: (BigInt(control.next_sequence) + 1n).toString(),
    })
    .where('id', '=', 1)
    .execute();
  await tx
    .insertInto('outbox')
    .values({
      session_id: sessionId,
      sequence: control.next_sequence,
      event_type: 'DEMO_MARKET_CHANGED',
      payload: { status: 'ACCEPTED' },
    })
    .execute();
}

/** Fictional bounded walk in cents, never a market feed or accounting approximation. */
function nextPrice(state: State): bigint {
  const noise = createHash('sha256')
    .update(`${state.session_id}:${state.cycle}`)
    .digest()
    .readUInt32BE();
  const previous = BigInt(state.reference_price);
  const next = previous + BigInt(noise % 12001) - 6000n + (5000000n - previous) / 20n;
  return next < 4800000n ? 4800000n : next > 5200000n ? 5200000n : next;
}

/** Internal scheduler. Administrator commands own durable intent; this worker only executes it. */
export class DemoMarket {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: Promise<void> | undefined;
  private stopping = false;
  private started = false;

  constructor(private readonly exchange: Exchange) {}

  start(): void {
    if (this.started || this.stopping) return;
    this.started = true;
    const run = async () => {
      if (this.stopping) return;
      try {
        await this.tick();
      } catch {
        // The durable plan retains the original command identity after an uncertain outcome.
        // runCycle records errors only while it still owns this simulator generation.
      }
      if (!this.stopping) this.timer = setTimeout(() => void run(), 4_000);
    };
    void run();
  }

  tick(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.pending ??= this.runCycle().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async prepare(): Promise<State | undefined> {
    // Avoid financial transactions during a halt. The command lock remains authoritative.
    const ready = await this.exchange.readTransaction(async (tx) => {
      const control = await tx
        .selectFrom('exchange_control')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return (
        control.market_state === 'TRADING' && !control.fault && !this.exchange.getRuntimeFault()
      );
    });
    if (!ready) return undefined;
    return this.exchange.financialTransaction(async (tx, control) => {
      const sessionId = control.active_session_id;
      if (!sessionId || control.market_state !== 'TRADING') return undefined;
      const state = await tx
        .selectFrom('demo_market')
        .selectAll()
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (!state?.enabled) return undefined;
      if (state.plan.length) return state;
      const plan: Planned[] = [];
      const open = await tx
        .selectFrom('orders')
        .select(['id', 'account_id'])
        .where('session_id', '=', sessionId)
        .where('account_id', 'in', [state.maker_account_id, state.taker_account_id])
        .where('status', 'in', ACTIVE)
        .orderBy('acceptance_sequence')
        .execute();
      for (const order of open)
        plan.push({
          type: 'cancel',
          input: {
            accountId: order.account_id,
            sessionId,
            commandId: randomUUID(),
            orderId: order.id,
          },
        });
      const price = nextPrice(state);
      const inventory = await tx
        .selectFrom('balances')
        .select('amount')
        .where('session_id', '=', sessionId)
        .where('account_id', '=', state.taker_account_id)
        .where('asset', '=', 'BTC-SIM')
        .execute();
      const base = inventory.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      for (const quote of quoteIntents(price, base)) {
        plan.push({
          type: 'limit',
          input: {
            accountId: quote.role === 'maker' ? state.maker_account_id : state.taker_account_id,
            sessionId,
            commandId: randomUUID(),
            side: quote.side,
            price: formatPrice(quote.price),
            quantity: formatQuantity(quote.quantity),
          },
        });
      }
      return tx
        .updateTable('demo_market')
        .set({
          reference_price: price.toString(),
          plan: JSON.stringify(plan),
          next_command: 0,
          status: 'RUNNING',
          updated_at: new Date(),
        })
        .where('session_id', '=', sessionId)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }

  private async owns(tx: Transaction<Database>, state: State): Promise<boolean> {
    const current = await tx
      .selectFrom('demo_market')
      .select(['enabled', 'generation'])
      .where('session_id', '=', state.session_id)
      .executeTakeFirst();
    return Boolean(current?.enabled && current.generation === state.generation);
  }

  private async runCycle(): Promise<void> {
    const state = await this.prepare();
    if (!state) return;
    try {
      const plan = state.plan as Planned[];
      for (let index = state.next_command; index < plan.length; index += 1) {
        if (this.stopping) return;
        const ready = await this.exchange.readTransaction(async (tx) => {
          const control = await tx
            .selectFrom('exchange_control')
            .selectAll()
            .where('id', '=', 1)
            .executeTakeFirstOrThrow();
          return (
            control.market_state === 'TRADING' &&
            !control.fault &&
            !this.exchange.getRuntimeFault() &&
            (await this.owns(tx, state))
          );
        });
        if (!ready) return;
        const command = plan[index]!;
        const result =
          command.type === 'limit'
            ? await this.exchange.placeLimit(command.input, undefined, state.generation)
            : await this.exchange.cancel(command.input, undefined, state.generation);
        if (result.code === 'STALE_SIMULATOR' || result.code === 'STALE_SESSION') return;
        // Terminal rejections advance too. An ambiguous outcome leaves the original ID to retry.
        const advanced = await this.exchange.accessTransaction(async (tx, control) => {
          if (!(await this.owns(tx, state))) return false;
          await tx
            .updateTable('demo_market')
            .set({
              next_command: index + 1,
              // A pause may win after dispatch's read. Rebuild cancellations on
              // resume instead of skipping the now-rejected cancellation forever.
              ...(result.code === 'MARKET_PAUSED' ? { plan: '[]', next_command: 0 } : {}),
              ...(result.code === 'INSUFFICIENT_FUNDS'
                ? { status: 'LIMITED_INVENTORY' as const }
                : {}),
              updated_at: new Date(),
            })
            .where('session_id', '=', state.session_id)
            .execute();
          if (result.code === 'INSUFFICIENT_FUNDS') await changed(tx, control, state.session_id);
          return true;
        });
        if (!advanced || result.code === 'MARKET_PAUSED' || result.code === 'INVARIANT_FAILURE')
          return;
        if (result.status === 'REJECTED' && result.code !== 'INSUFFICIENT_FUNDS')
          throw new Error('DEMO_COMMAND_REJECTED');
      }
      await this.exchange.accessTransaction(async (tx, control) => {
        if (!(await this.owns(tx, state))) return;
        await tx
          .updateTable('demo_market')
          .set({
            cycle: (BigInt(state.cycle) + 1n).toString(),
            plan: '[]',
            next_command: 0,
            updated_at: new Date(),
          })
          .where('session_id', '=', state.session_id)
          .execute();
        await changed(tx, control, state.session_id);
      });
    } catch (error) {
      await this.reportError(state);
      throw error;
    }
  }

  private async reportError(state: State): Promise<void> {
    try {
      await this.exchange.accessTransaction(async (tx, control) => {
        if (!(await this.owns(tx, state))) return;
        await tx
          .updateTable('demo_market')
          .set({ status: 'ERROR', updated_at: new Date() })
          .where('session_id', '=', state.session_id)
          .execute();
        await changed(tx, control, state.session_id);
      });
    } catch {
      /* Lost database access: preserve durable intent for the next fenced process. */
    }
  }

  /** Drain this process only. Admin stop is a separate, durable, audited command. */
  async close(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    try {
      await this.pending;
    } catch {
      /* The persisted plan resolves uncertain work on restart. */
    }
  }
}
