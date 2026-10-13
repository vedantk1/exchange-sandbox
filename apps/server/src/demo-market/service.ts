import { createHash, randomUUID } from 'node:crypto';
import type { Database } from '@sandbox/database';
import { formatPrice } from '@sandbox/domain';
import type { Selectable, Transaction } from 'kysely';
import { allocateTrader } from '../core-mutations.js';
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

/** One internal producer inside the fenced exchange process. No login or privileged HTTP route. */
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
        if (!this.stopping) await this.reportError(true);
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

  private async state(): Promise<State | undefined> {
    return this.exchange.readTransaction(async (tx) => {
      const control = await tx
        .selectFrom('exchange_control')
        .select('active_session_id')
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      if (!control.active_session_id) return undefined;
      return tx
        .selectFrom('demo_market')
        .selectAll()
        .where('session_id', '=', control.active_session_id)
        .executeTakeFirst();
    });
  }

  private async ready(): Promise<boolean> {
    return this.exchange.readTransaction(async (tx) => {
      const control = await tx
        .selectFrom('exchange_control')
        .selectAll()
        .where('id', '=', 1)
        .executeTakeFirstOrThrow();
      return Boolean(
        control.active_session_id &&
        control.market_state === 'TRADING' &&
        !control.fault &&
        !this.exchange.getRuntimeFault(),
      );
    });
  }

  private async prepare(): Promise<State | undefined> {
    // Access transactions allow an existing enabled simulator to be disclosed during a fault.
    await this.exchange.accessTransaction(async (tx, control) => {
      if (!control.active_session_id) return;
      const existing = await tx
        .selectFrom('demo_market')
        .selectAll()
        .where('session_id', '=', control.active_session_id)
        .executeTakeFirst();
      if (existing && !existing.enabled) {
        await tx
          .updateTable('demo_market')
          .set({ enabled: true, updated_at: new Date() })
          .where('session_id', '=', existing.session_id)
          .execute();
        await changed(tx, control, existing.session_id);
      }
    });
    if (!(await this.ready())) return undefined;
    return this.exchange.financialTransaction(async (tx, control) => {
      const sessionId = control.active_session_id;
      if (!sessionId || control.market_state !== 'TRADING') return undefined;
      let state = await tx
        .selectFrom('demo_market')
        .selectAll()
        .where('session_id', '=', sessionId)
        .executeTakeFirst();
      if (!state) {
        const maker = randomUUID();
        const taker = randomUUID();
        for (const [id, label] of [
          [maker, 'Demo market maker'],
          [taker, 'Demo market taker'],
        ] as const) {
          await tx.insertInto('accounts').values({ id, kind: 'TRADER', label }).execute();
          await allocateTrader(tx, sessionId, id, randomUUID());
        }
        state = await tx
          .insertInto('demo_market')
          .values({
            session_id: sessionId,
            maker_account_id: maker,
            taker_account_id: taker,
            enabled: true,
            status: 'RUNNING',
            plan: '[]',
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await changed(tx, control, sessionId);
      }
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
      const quote = (accountId: string, side: 'BUY' | 'SELL', cents: bigint, quantity: string) => {
        plan.push({
          type: 'limit',
          input: {
            accountId,
            sessionId,
            commandId: randomUUID(),
            side,
            price: formatPrice(cents),
            quantity,
          },
        });
      };
      quote(state.maker_account_id, 'BUY', price - 3000n, '0.0200');
      quote(state.maker_account_id, 'BUY', price - 1000n, '0.0200');
      quote(state.maker_account_id, 'SELL', price + 1000n, '0.0200');
      quote(state.maker_account_id, 'SELL', price + 3000n, '0.0200');
      const inventory = await tx
        .selectFrom('balances')
        .select('amount')
        .where('session_id', '=', sessionId)
        .where('account_id', '=', state.taker_account_id)
        .where('asset', '=', 'BTC-SIM')
        .execute();
      const base = inventory.reduce((sum, row) => sum + BigInt(row.amount), 0n);
      // Restore the taker's starting inventory; alternate around it when no human intervenes.
      const side = base <= 10000n ? 'BUY' : 'SELL';
      quote(state.taker_account_id, side, side === 'BUY' ? price + 1000n : price - 1000n, '0.0010');
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

  private async runCycle(): Promise<void> {
    const state = await this.prepare();
    if (!state) return;
    const plan = state.plan as Planned[];
    for (let index = state.next_command; index < plan.length; index += 1) {
      if (this.stopping || !(await this.ready())) return;
      const command = plan[index]!;
      const result =
        command.type === 'limit'
          ? await this.exchange.placeLimit(command.input)
          : await this.exchange.cancel(command.input);
      // A committed rejection is terminal too. In particular, do not retry insufficient funds forever.
      await this.exchange.accessTransaction(async (tx, control) => {
        await tx
          .updateTable('demo_market')
          .set({
            next_command: index + 1,
            ...(result.code === 'INSUFFICIENT_FUNDS'
              ? { status: 'LIMITED_INVENTORY' as const }
              : {}),
            updated_at: new Date(),
          })
          .where('session_id', '=', state.session_id)
          .execute();
        if (result.code === 'INSUFFICIENT_FUNDS') await changed(tx, control, state.session_id);
      });
      if (result.code === 'MARKET_PAUSED' || result.code === 'INVARIANT_FAILURE') return;
      if (result.status === 'REJECTED' && result.code !== 'INSUFFICIENT_FUNDS')
        throw new Error('DEMO_COMMAND_REJECTED');
    }
    await this.exchange.accessTransaction(async (tx, control) => {
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
  }

  private async reportError(skipWhenStopping = false): Promise<void> {
    try {
      const state = await this.state();
      if (!state) return;
      await this.exchange.accessTransaction(async (tx, control) => {
        if (skipWhenStopping && this.stopping) return;
        await tx
          .updateTable('demo_market')
          .set({ status: 'ERROR', updated_at: new Date() })
          .where('session_id', '=', state.session_id)
          .execute();
        await changed(tx, control, state.session_id);
      });
    } catch {
      /* Lost database access: leave intent intact for the next fenced process. */
    }
  }

  /** Disable intent first, then clean only these accounts. Never delete fills or refill inventory. */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    try {
      await this.pending;
    } catch {
      /* Resolve remaining orders from PostgreSQL below. */
    }
    const state = await this.state();
    if (!state) return;
    if (!state.enabled && state.status === 'STOPPED' && state.plan.length === 0) return;
    await this.exchange.accessTransaction(async (tx, control) => {
      await tx
        .updateTable('demo_market')
        .set({ enabled: false, status: 'ERROR', updated_at: new Date() })
        .where('session_id', '=', state.session_id)
        .execute();
      await changed(tx, control, state.session_id);
    });
    try {
      const orders = await this.exchange.readTransaction((tx) =>
        tx
          .selectFrom('orders')
          .select(['id', 'account_id'])
          .where('session_id', '=', state.session_id)
          .where('account_id', 'in', [state.maker_account_id, state.taker_account_id])
          .where('status', 'in', ACTIVE)
          .execute(),
      );
      for (const order of orders) {
        const result = await this.exchange.cancel({
          sessionId: state.session_id,
          accountId: order.account_id,
          orderId: order.id,
          commandId: randomUUID(),
        });
        if (result.status !== 'ACCEPTED') throw new Error('DEMO_CLEANUP_REJECTED');
      }
      await this.exchange.accessTransaction(async (tx, control) => {
        await tx
          .updateTable('demo_market')
          .set({ status: 'STOPPED', plan: '[]', next_command: 0, updated_at: new Date() })
          .where('session_id', '=', state.session_id)
          .execute();
        await changed(tx, control, state.session_id);
      });
    } catch {
      // Fault-safe inspection remains available; leftover orders and ERROR stay visible.
      await this.reportError();
    }
  }
}
