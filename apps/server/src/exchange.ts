import { createHash, randomUUID } from 'node:crypto';
import { createDatabase, migrate, type Database } from '@sandbox/database';
import {
  assertOrderSubmission,
  buyReservation,
  DomainError,
  fee,
  formatPrice,
  formatQuantity,
  formatQuote,
  matchOrder,
  notional,
  parsePrice,
  parseQuantity,
  type BookOrder,
} from '@sandbox/domain';
import { sql, type Kysely, type Selectable, type Transaction } from 'kysely';
import { Client } from 'pg';
import { CommandConflictError, RecoveryError, WriterUnavailableError } from './errors.js';
import { postJournal, transferHold, type Posting } from './ledger.js';
import { reconcileDatabase } from './reconcile.js';
import type {
  CancelCommand,
  CommandIdentity,
  CommandResult,
  ExchangeOptions,
  LimitCommand,
  Snapshot,
} from './types.js';
import { bookOrder, fillView, orderView } from './views.js';
import { allocateTrader, initializeSession } from './core-mutations.js';
import { requirePrincipal } from './auth/access.js';
import { AuthError } from './auth/errors.js';
import { admitRequest, checkPendingAdmission, COMMAND_LOCK_TIMEOUT_MS } from './admission.js';

export type * from './types.js';
export { CommandConflictError, RecoveryError, WriterUnavailableError } from './errors.js';

export type Control = Selectable<Database['exchange_control']>;
type Outcome = Pick<CommandResult, 'status' | 'fills'> &
  Partial<Pick<CommandResult, 'code' | 'order'>>;
const ACTIVE = ['OPEN', 'PARTIALLY_FILLED'] as const;
const WRITER_LOCK = 7_314_921;

function uuid(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  ) {
    throw new DomainError('INVALID_ID', 'IDs must be lowercase UUID strings.');
  }
}

function fingerprint(payload: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function held(order: BookOrder): bigint {
  return order.side === 'BUY' ? buyReservation(order.remaining, order.price) : order.remaining;
}

function rejection(code: string): Outcome {
  return { status: 'REJECTED', code, fills: [] };
}

/** Application boundary. HTTP calls supply a session token, rechecked under the command lock. */
export class Exchange {
  private epoch = '';
  private available = true;
  private closed = false;
  private runtimeFault: string | null = null;
  private faultRevision = 0;

  private constructor(
    private readonly db: Kysely<Database>,
    private readonly guard: Client,
    private readonly options: ExchangeOptions,
  ) {
    guard.on('error', () => {
      this.available = false;
    });
    guard.on('end', () => {
      this.available = false;
    });
  }

  static async open(databaseUrl: string, options: ExchangeOptions = {}): Promise<Exchange> {
    const db = createDatabase(databaseUrl, {
      onError: () => {
        exchange.available = false;
      },
    });
    const guard = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000 });
    const exchange = new Exchange(db, guard, options);
    try {
      await guard.connect();
      const lock = await guard.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [WRITER_LOCK],
      );
      if (!lock.rows[0]?.acquired) throw new WriterUnavailableError();
      await migrate(db);
      const fault = await db.transaction().execute(async (tx) => {
        const control = await tx
          .selectFrom('exchange_control')
          .selectAll()
          .where('id', '=', 1)
          .forUpdate()
          .executeTakeFirstOrThrow();
        exchange.epoch = (BigInt(control.writer_epoch) + 1n).toString();
        const report = await reconcileDatabase(tx);
        const fault = control.fault ?? (report.ok ? null : report.issues.join('; '));
        await tx
          .updateTable('exchange_control')
          .set({ writer_epoch: exchange.epoch, fault })
          .where('id', '=', 1)
          .execute();
        return fault;
      });
      if (fault && !options.allowFaultedStartup) throw new RecoveryError(fault);
      return exchange;
    } catch (error) {
      await exchange.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.available = false;
    // Finish outstanding database transactions before releasing writer ownership.
    try {
      await this.db.destroy();
    } finally {
      await this.guard.end();
    }
  }

  private assertWriter(): void {
    if (!this.available || this.closed) throw new WriterUnavailableError();
  }

  private async lock(tx: Transaction<Database>, permitFault = false): Promise<Control> {
    this.assertWriter();
    checkPendingAdmission();
    await sql`SELECT set_config('lock_timeout', ${`${COMMAND_LOCK_TIMEOUT_MS}ms`}, true)`.execute(
      tx,
    );
    const control = await tx
      .selectFrom('exchange_control')
      .selectAll()
      .where('id', '=', 1)
      .forUpdate()
      .executeTakeFirstOrThrow();
    this.assertWriter();
    if (control.writer_epoch !== this.epoch) throw new WriterUnavailableError();
    const fault = this.runtimeFault ?? control.fault;
    if (fault && !permitFault) throw new RecoveryError(fault);
    admitRequest();
    return { ...control, fault };
  }

  /** Internal module boundary: use for reads and access revocation during a financial halt. */
  async accessTransaction<T>(
    work: (tx: Transaction<Database>, control: Control) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (tx) => {
      const control = await this.lock(tx, true);
      const result = await work(tx, control);
      this.assertWriter();
      return result;
    });
  }

  async readTransaction<T>(work: (tx: Transaction<Database>) => Promise<T>): Promise<T> {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .setAccessMode('read only')
      .execute(work);
  }

  /** Only recovery/admin modules may use this; callers must reconcile before clearing a fault. */
  async recoveryTransaction<T>(
    work: (tx: Transaction<Database>, control: Control) => Promise<T>,
  ): Promise<T> {
    return this.financialTransaction(work, undefined, true);
  }

  getRuntimeFault(): string | null {
    return this.runtimeFault;
  }

  getRuntimeFaultRevision(): number {
    return this.faultRevision;
  }

  clearRuntimeFault(expectedRevision: number): void {
    if (expectedRevision === this.faultRevision) this.runtimeFault = null;
  }

  async financialTransaction<T>(
    execute: (tx: Transaction<Database>, control: Control) => Promise<T>,
    onFault?: (tx: Transaction<Database>, control: Control) => Promise<T>,
    permitFault = false,
  ): Promise<T> {
    let failed = false;
    let result: T | undefined;
    try {
      result = await this.db.transaction().execute(async (tx) => {
        const control = await this.lock(tx, permitFault);
        await sql`SAVEPOINT financial_effects`.execute(tx);
        try {
          const value = await execute(tx, control);
          await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
          this.assertWriter();
          return value;
        } catch (error) {
          if (
            !(error instanceof RecoveryError) &&
            (error as { code?: string })?.code !== '23514' &&
            !(error instanceof DomainError && error.code === 'INVALID_BOOK')
          )
            throw error;
          failed = true;
          this.faultRevision += 1;
          this.runtimeFault = 'Financial invariant failed; inspect journal and projections.';
          // Keep the installation row lock while rolling back financial work.
          // Queued commands cannot pass between the failed trade and its halt.
          await sql`ROLLBACK TO SAVEPOINT financial_effects`.execute(tx);
          await tx
            .updateTable('exchange_control')
            .set({ fault: this.runtimeFault })
            .where('id', '=', 1)
            .execute();
          return onFault ? await onFault(tx, control) : undefined;
        }
      });
    } catch (error) {
      if (failed) {
        // If the original connection cannot commit the halt, keep the local
        // gate latched and attempt a separate fenced transaction. Never resume
        // merely because recording the diagnostic also failed.
        try {
          await this.db.transaction().execute(async (tx) => {
            await this.lock(tx, true);
            await tx
              .updateTable('exchange_control')
              .set({ fault: this.runtimeFault })
              .where('id', '=', 1)
              .execute();
          });
        } catch {
          /* The local gate remains latched until the process is closed. */
        }
      }
      throw error;
    }
    if (failed && !onFault) throw new RecoveryError(this.runtimeFault!);
    return result as T;
  }

  private async sequence(tx: Transaction<Database>, control: Control): Promise<string> {
    await tx
      .updateTable('exchange_control')
      .set({
        next_sequence: (BigInt(control.next_sequence) + 1n).toString(),
      })
      .where('id', '=', 1)
      .execute();
    return control.next_sequence;
  }

  /** Trusted demo fixture; the owner setup command bootstraps the HTTP installation paused. */
  async bootstrap(): Promise<{
    sessionId: string;
    feeAccountId: string;
    issuanceAccountId: string;
  }> {
    return this.accessTransaction(async (tx, control) => {
      if (control.fault) throw new RecoveryError(control.fault);
      return initializeSession(tx, { marketState: 'TRADING' });
    });
  }

  async createTrader(input: {
    accountId: string;
    label: string;
    commandId: string;
  }): Promise<{ accountId: string; sessionId: string }> {
    input = { ...input };
    uuid(input.accountId);
    uuid(input.commandId);
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 80) {
      throw new DomainError('INVALID_LABEL', 'Use a nonempty label of at most 80 characters.');
    }
    const hash = fingerprint({
      type: 'CREATE_TRADER',
      accountId: input.accountId,
      label: input.label,
    });
    return this.financialTransaction(async (tx, control) => {
      const prior = await this.receipt(tx, input.accountId, input.commandId, hash);
      if (prior) return prior as unknown as { accountId: string; sessionId: string };
      const sessionId = control.active_session_id;
      if (!sessionId)
        throw new DomainError('NOT_BOOTSTRAPPED', 'Bootstrap the local exchange first.');
      const existing = await tx
        .selectFrom('accounts')
        .selectAll()
        .where('id', '=', input.accountId)
        .executeTakeFirst();
      if (existing && existing.kind !== 'TRADER')
        throw new DomainError('INVALID_ACCOUNT', 'A system account cannot become a trader.');
      if (!existing)
        await tx
          .insertInto('accounts')
          .values({
            id: input.accountId,
            kind: 'TRADER',
            label: input.label,
          })
          .execute();
      await allocateTrader(tx, sessionId, input.accountId, input.commandId);
      const sequence = await this.sequence(tx, control);
      const result = { accountId: input.accountId, sessionId };
      await this.persistReceipt(
        tx,
        { ...input, sessionId },
        hash,
        sequence,
        result,
        'TRADER_CREATED',
      );
      this.assertWriter();
      return result;
    });
  }

  private async receipt(
    tx: Transaction<Database>,
    actor: string,
    commandId: string,
    hash: string,
  ): Promise<Record<string, unknown> | null> {
    const prior = await tx
      .selectFrom('receipts')
      .selectAll()
      .where('actor_id', '=', actor)
      .where('command_id', '=', commandId)
      .executeTakeFirst();
    if (!prior) return null;
    if (prior.payload_hash !== hash) throw new CommandConflictError();
    return prior.result;
  }

  private async persistReceipt(
    tx: Transaction<Database>,
    identity: CommandIdentity,
    hash: string,
    sequence: string,
    result: object,
    eventType: string,
  ): Promise<void> {
    // Serialization is also a guard against accidentally leaking bigint through the API.
    const payload = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;
    await tx
      .insertInto('receipts')
      .values({
        actor_id: identity.accountId,
        command_id: identity.commandId,
        session_id: identity.sessionId,
        payload_hash: hash,
        sequence,
        result: payload,
      })
      .execute();
    await tx
      .insertInto('outbox')
      .values({
        session_id: identity.sessionId,
        sequence,
        event_type: eventType,
        payload: { accountId: identity.accountId, ...payload },
      })
      .execute();
  }

  private async command(
    identity: CommandIdentity,
    hash: string,
    execute: (tx: Transaction<Database>, control: Control, sequence: string) => Promise<Outcome>,
    accessToken?: string,
  ): Promise<CommandResult> {
    let replay = false;
    const result = await this.financialTransaction<CommandResult>(
      async (tx, control) => {
        if (accessToken !== undefined) {
          const actor = await requirePrincipal(tx, accessToken, 'TRADER');
          if (actor.accountId !== identity.accountId)
            throw new DomainError('NOT_ORDER_OWNER', 'Actor does not own this account.');
        }
        const prior = await this.receipt(tx, identity.accountId, identity.commandId, hash);
        if (prior) {
          replay = true;
          return prior as unknown as CommandResult;
        }
        const account = await tx
          .selectFrom('accounts')
          .select('kind')
          .where('id', '=', identity.accountId)
          .executeTakeFirst();
        if (account?.kind !== 'TRADER')
          throw new DomainError('INVALID_ACCOUNT', 'A known trader is required.');
        const sequence = await this.sequence(tx, control);
        const outcome =
          control.active_session_id !== identity.sessionId
            ? rejection('STALE_SESSION')
            : await execute(tx, control, sequence);
        const result: CommandResult = {
          commandId: identity.commandId,
          sessionId: identity.sessionId,
          sequence,
          ...outcome,
        };
        await this.persistReceipt(tx, identity, hash, sequence, result, 'COMMAND_COMPLETED');
        // Flush deferred financial checks before exposing the crash injection boundary.
        await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
        await this.options.hooks?.beforeCommit?.(identity.commandId);
        this.assertWriter();
        return result;
      },
      async (tx, control) => {
        const sequence = await this.sequence(tx, control);
        const result: CommandResult = {
          commandId: identity.commandId,
          sessionId: identity.sessionId,
          sequence,
          status: 'REJECTED',
          code: 'INVARIANT_FAILURE',
          fills: [],
        };
        await this.persistReceipt(tx, identity, hash, sequence, result, 'COMMAND_FAILED');
        return result;
      },
    );
    if (!replay) await this.options.hooks?.afterCommit?.(identity.commandId);
    return result;
  }

  async placeLimit(input: LimitCommand, accessToken?: string): Promise<CommandResult> {
    input = { ...input };
    uuid(input.accountId);
    uuid(input.commandId);
    uuid(input.sessionId);
    if (input.side !== 'BUY' && input.side !== 'SELL')
      throw new DomainError('INVALID_SIDE', 'Side must be BUY or SELL.');
    const quantity = parseQuantity(input.quantity);
    const price = parsePrice(input.price);
    // Semantically identical exact decimals share a fingerprint.
    const hash = fingerprint({
      type: 'PLACE_LIMIT',
      accountId: input.accountId,
      sessionId: input.sessionId,
      side: input.side,
      quantity: formatQuantity(quantity),
      price: formatPrice(price),
    });
    return this.command(
      input,
      hash,
      async (tx, control, sequence) => {
        if (control.market_state !== 'TRADING') return rejection('MARKET_PAUSED');
        try {
          assertOrderSubmission(quantity, price);
        } catch (error) {
          if (error instanceof DomainError) return rejection(error.code);
          throw error;
        }
        const restingRows = await tx
          .selectFrom('orders')
          .selectAll()
          .where('session_id', '=', input.sessionId)
          .where('status', 'in', ACTIVE)
          .execute();
        if (restingRows.filter((order) => order.account_id === input.accountId).length >= 50)
          return rejection('OPEN_ORDER_LIMIT');
        const incoming: BookOrder = {
          id: randomUUID(),
          accountId: input.accountId,
          side: input.side,
          quantity,
          remaining: quantity,
          price,
          sequence: BigInt(sequence),
        };
        const reserve = held(incoming);
        const asset = input.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM';
        const balance = await tx
          .selectFrom('balances')
          .select('amount')
          .where('session_id', '=', input.sessionId)
          .where('account_id', '=', input.accountId)
          .where('asset', '=', asset)
          .where('bucket', '=', 'AVAILABLE')
          .executeTakeFirst();
        if (BigInt(balance?.amount ?? '0') < reserve) return rejection('INSUFFICIENT_FUNDS');
        const match = matchOrder(incoming, restingRows.map(bookOrder));
        await tx
          .insertInto('orders')
          .values({
            id: incoming.id,
            session_id: input.sessionId,
            account_id: input.accountId,
            side: input.side,
            type: 'LIMIT',
            status: 'OPEN',
            quantity: quantity.toString(),
            remaining_quantity: quantity.toString(),
            price: price.toString(),
            acceptance_sequence: sequence,
            reserved_amount: reserve.toString(),
            cancel_reason: null,
          })
          .execute();

        const feeAccount = await tx
          .selectFrom('accounts')
          .select('id')
          .where('kind', '=', 'FEE')
          .executeTakeFirstOrThrow();
        const postings = transferHold(input.accountId, asset, reserve);
        const originals = new Map(restingRows.map((row) => [row.id, bookOrder(row)]));
        const fills: CommandResult['fills'] = [];
        for (const [fillIndex, fill] of match.fills.entries()) {
          const maker = originals.get(fill.makerOrderId)!;
          const buy = input.side === 'BUY' ? incoming : maker;
          const sell = input.side === 'SELL' ? incoming : maker;
          const value = notional(fill.quantity, fill.price);
          const charge = fee(fill.quantity, fill.price);
          const consumedHold = buyReservation(fill.quantity, buy.price);
          const fillPostings: Posting[] = [
            {
              accountId: buy.accountId,
              asset: 'USD-SIM',
              bucket: 'RESERVED',
              amount: -consumedHold,
            },
            {
              accountId: buy.accountId,
              asset: 'USD-SIM',
              bucket: 'AVAILABLE',
              amount: consumedHold - value - charge,
            },
            {
              accountId: sell.accountId,
              asset: 'USD-SIM',
              bucket: 'AVAILABLE',
              amount: value - charge,
            },
            {
              accountId: feeAccount.id,
              asset: 'USD-SIM',
              bucket: 'AVAILABLE',
              amount: 2n * charge,
            },
            {
              accountId: sell.accountId,
              asset: 'BTC-SIM',
              bucket: 'RESERVED',
              amount: -fill.quantity,
            },
            {
              accountId: buy.accountId,
              asset: 'BTC-SIM',
              bucket: 'AVAILABLE',
              amount: fill.quantity,
            },
          ];
          postings.push(...fillPostings);
          const row = await tx
            .insertInto('fills')
            .values({
              id: randomUUID(),
              session_id: input.sessionId,
              maker_order_id: maker.id,
              taker_order_id: incoming.id,
              buy_order_id: buy.id,
              sell_order_id: sell.id,
              quantity: fill.quantity.toString(),
              price: fill.price.toString(),
              notional: value.toString(),
              buyer_fee: charge.toString(),
              seller_fee: charge.toString(),
              sequence,
              fill_index: fillIndex,
            })
            .returningAll()
            .executeTakeFirstOrThrow();
          fills.push(fillView(row));
        }
        for (const maker of match.makers) {
          await tx
            .updateTable('orders')
            .set({
              remaining_quantity: maker.remaining.toString(),
              status: maker.status,
              reserved_amount: held(maker).toString(),
              updated_at: new Date(),
            })
            .where('id', '=', maker.id)
            .execute();
        }
        const canceled = match.incoming.status === 'CANCELED';
        if (canceled) postings.push(...transferHold(input.accountId, asset, -held(match.incoming)));
        const order = await tx
          .updateTable('orders')
          .set({
            remaining_quantity: match.incoming.remaining.toString(),
            status: match.incoming.status,
            reserved_amount: (canceled ? 0n : held(match.incoming)).toString(),
            cancel_reason: match.incoming.cancelReason,
            updated_at: new Date(),
          })
          .where('id', '=', incoming.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        await postJournal(tx, input.sessionId, input.commandId, 'PLACE_LIMIT', postings);
        return { status: 'ACCEPTED', order: orderView(order), fills };
      },
      accessToken,
    );
  }

  async cancel(input: CancelCommand, accessToken?: string): Promise<CommandResult> {
    input = { ...input };
    uuid(input.accountId);
    uuid(input.commandId);
    uuid(input.sessionId);
    uuid(input.orderId);
    const hash = fingerprint({
      type: 'CANCEL',
      accountId: input.accountId,
      sessionId: input.sessionId,
      orderId: input.orderId,
    });
    return this.command(
      input,
      hash,
      async (tx) => {
        const order = await tx
          .selectFrom('orders')
          .selectAll()
          .where('id', '=', input.orderId)
          .where('session_id', '=', input.sessionId)
          .executeTakeFirst();
        if (!order) return rejection('ORDER_NOT_FOUND');
        if (order.account_id !== input.accountId) return rejection('NOT_ORDER_OWNER');
        if (order.status === 'FILLED' || order.status === 'CANCELED')
          return { status: 'ACCEPTED', order: orderView(order), fills: [] };
        await postJournal(
          tx,
          input.sessionId,
          input.commandId,
          'CANCEL',
          transferHold(
            input.accountId,
            order.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM',
            -BigInt(order.reserved_amount),
          ),
        );
        const updated = await tx
          .updateTable('orders')
          .set({
            status: 'CANCELED',
            reserved_amount: '0',
            cancel_reason: 'USER_REQUEST',
            updated_at: new Date(),
          })
          .where('id', '=', order.id)
          .returningAll()
          .executeTakeFirstOrThrow();
        return { status: 'ACCEPTED', order: orderView(updated), fills: [] };
      },
      accessToken,
    );
  }

  async getReceipt(accountId: string, commandId: string): Promise<CommandResult | null> {
    uuid(accountId);
    uuid(commandId);
    const row = await this.db
      .selectFrom('receipts')
      .select('result')
      .where('actor_id', '=', accountId)
      .where('command_id', '=', commandId)
      .executeTakeFirst();
    // Developer allocation receipts have a separate result shape. This query
    // resolves trading commands only; callers retry createTrader for setup.
    if (!row || !('status' in row.result)) return null;
    return row.result as unknown as CommandResult;
  }

  async snapshot(
    accountId: string,
    accessToken?: string,
    historyLimit?: number,
  ): Promise<Snapshot> {
    uuid(accountId);
    // A consistent read transaction avoids mixing balances and orders from two commits.
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        if (accessToken !== undefined) {
          const actor = await requirePrincipal(tx, accessToken);
          if (actor.role !== 'ADMIN' && actor.accountId !== accountId)
            throw new AuthError('FORBIDDEN', 'Private account access is restricted.', 403);
        }
        const control = await tx
          .selectFrom('exchange_control')
          .selectAll()
          .where('id', '=', 1)
          .executeTakeFirstOrThrow();
        if (!control.active_session_id)
          throw new DomainError('NOT_BOOTSTRAPPED', 'Bootstrap the local exchange first.');
        const sessionId = control.active_session_id;
        const rows = await tx
          .selectFrom('balances')
          .selectAll()
          .where('session_id', '=', sessionId)
          .where('account_id', '=', accountId)
          .execute();
        const balance = (asset: 'BTC-SIM' | 'USD-SIM') => {
          const available = BigInt(
            rows.find((r) => r.asset === asset && r.bucket === 'AVAILABLE')?.amount ?? '0',
          );
          const reserved = BigInt(
            rows.find((r) => r.asset === asset && r.bucket === 'RESERVED')?.amount ?? '0',
          );
          const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
          return {
            available: format(available),
            reserved: format(reserved),
            total: format(available + reserved),
          };
        };
        const orders = await tx
          .selectFrom('orders')
          .selectAll()
          .where('session_id', '=', sessionId)
          .where('account_id', '=', accountId)
          .orderBy('acceptance_sequence', historyLimit ? 'desc' : 'asc')
          .$if(historyLimit !== undefined, (query) => query.limit(historyLimit!))
          .execute();
        const fills = await tx
          .selectFrom('fills')
          .selectAll()
          .where('session_id', '=', sessionId)
          .where((eb) =>
            eb.or([
              eb(
                'buy_order_id',
                'in',
                tx.selectFrom('orders').select('id').where('account_id', '=', accountId),
              ),
              eb(
                'sell_order_id',
                'in',
                tx.selectFrom('orders').select('id').where('account_id', '=', accountId),
              ),
            ]),
          )
          .orderBy('sequence', historyLimit ? 'desc' : 'asc')
          .orderBy('fill_index', historyLimit ? 'desc' : 'asc')
          .$if(historyLimit !== undefined, (query) => query.limit(historyLimit!))
          .execute();
        return {
          sessionId,
          balances: { 'BTC-SIM': balance('BTC-SIM'), 'USD-SIM': balance('USD-SIM') },
          orders: (historyLimit ? orders.reverse() : orders).map(orderView),
          fills: (historyLimit ? fills.reverse() : fills).map(fillView),
        };
      });
  }

  async reconcile(): Promise<{ ok: boolean; issues: string[] }> {
    return this.db.transaction().execute(async (tx) => {
      await this.lock(tx, true);
      const report = await reconcileDatabase(tx);
      if (!report.ok)
        await tx
          .updateTable('exchange_control')
          .set({ fault: report.issues.join('; ') })
          .where('id', '=', 1)
          .execute();
      return report;
    });
  }
}
