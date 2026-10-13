import type { FastifyReply } from 'fastify';
import type { Database } from '@sandbox/database';
import type { Selectable } from 'kysely';
import type { Exchange } from './exchange.js';
import { requirePrincipal, type Principal } from './auth/index.js';
import { AuthError } from './auth/errors.js';
import { currentCursor } from './workspace.js';

export interface LiveOptions {
  pollMs?: number;
  heartbeatMs?: number;
  maxStreams?: number;
  maxStreamsPerAccount?: number;
}

type Outbox = Selectable<Database['outbox']>;
const REPLAY_LIMIT = 1_000;

function visible(event: Outbox, actor: Principal): boolean {
  if (actor.role === 'ADMIN' || event.payload.accountId === actor.accountId) return true;
  if (event.payload.status !== 'ACCEPTED') return false;
  if (
    [
      'COMMAND_COMPLETED',
      'ORDER_CANCELED_BY_ADMIN',
      'TRADER_SUSPENDED',
      'MARKET_PAUSED',
      'MARKET_RESUMED',
      'DEMO_MARKET_CHANGED',
    ].includes(event.event_type)
  )
    return true;
  if (event.event_type === 'FUNDS_GRANTED') {
    const data = event.payload.data as { grant?: { accountId?: string } } | undefined;
    return data?.grant?.accountId === actor.accountId;
  }
  return false;
}

/** Committed outbox positions invalidate snapshots; no private records are delivered. */
export class LiveUpdates {
  private readonly streams = new Set<() => void>();
  private readonly accounts = new Map<string, number>();
  private readonly options: Required<LiveOptions>;
  private closed = false;

  constructor(
    private readonly exchange: Exchange,
    options: LiveOptions = {},
  ) {
    this.options = {
      pollMs: 1_000,
      heartbeatMs: 10_000,
      maxStreams: 32,
      maxStreamsPerAccount: 3,
      ...options,
    };
    if (Object.values(this.options).some((value) => !Number.isSafeInteger(value) || value < 1))
      throw new Error('Live update limits must be positive integers.');
  }

  async connect(
    reply: FastifyReply,
    token: string,
    requestedSession: string,
    requestedCursor: string,
  ): Promise<void> {
    const actor = await this.exchange.readTransaction((tx) => requirePrincipal(tx, token));
    if (
      this.closed ||
      this.streams.size >= this.options.maxStreams ||
      (this.accounts.get(actor.accountId) ?? 0) >= this.options.maxStreamsPerAccount
    ) {
      throw new AuthError(
        'STREAM_LIMIT',
        'Too many live connections. Close an unused tab and retry.',
        503,
      );
    }
    let cursor = requestedCursor;
    let sessionId = requestedSession;
    let signature: string | undefined;
    let initial = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSent = 0;
    const raw = reply.raw;
    const cleanup = () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      this.streams.delete(close);
      const remaining = (this.accounts.get(actor.accountId) ?? 1) - 1;
      if (remaining === 0) this.accounts.delete(actor.accountId);
      else this.accounts.set(actor.accountId, remaining);
      raw.off('close', cleanup);
    };
    const close = () => {
      cleanup();
      raw.end();
    };
    this.streams.add(close);
    this.accounts.set(actor.accountId, (this.accounts.get(actor.accountId) ?? 0) + 1);
    raw.once('close', cleanup);
    reply.hijack();
    for (const [name, value] of Object.entries(reply.getHeaders())) {
      if (value !== undefined) raw.setHeader(name, value);
    }
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    raw.flushHeaders();
    raw.socket?.setTimeout(0);

    const send = (event: string, payload: object, id?: string) => {
      if (stopped) return;
      const frame = `${id === undefined ? '' : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
      // One bounded frame, then disconnect on backpressure; do not queue a backlog.
      if (!raw.write(frame)) {
        cleanup();
        raw.destroy();
      }
      lastSent = performance.now();
    };
    const tick = async () => {
      if (stopped) return;
      try {
        const head = await this.exchange.readTransaction(async (tx) => {
          const principal = await requirePrincipal(tx, token);
          const control = await tx
            .selectFrom('exchange_control')
            .selectAll()
            .where('id', '=', 1)
            .executeTakeFirstOrThrow();
          if (!control.active_session_id)
            throw new AuthError('NOT_BOOTSTRAPPED', 'Complete administrator setup first.', 503);
          const active = control.active_session_id;
          const high = await currentCursor(tx, active);
          const gap =
            active !== sessionId ||
            BigInt(cursor) > BigInt(high) ||
            (cursor !== '0' &&
              !(await tx
                .selectFrom('outbox')
                .select('id')
                .where('session_id', '=', active)
                .where('id', '=', cursor)
                .executeTakeFirst()));
          const events = gap
            ? []
            : await tx
                .selectFrom('outbox')
                .selectAll()
                .where('session_id', '=', active)
                .where('id', '>', cursor)
                .orderBy('id')
                .limit(REPLAY_LIMIT + 1)
                .execute();
          return {
            sessionId: active,
            cursor: high,
            reset: Boolean(gap) || events.length > REPLAY_LIMIT,
            changed: events.some((event) => visible(event, principal)),
            signature: `${active}:${control.market_state}:${Boolean(this.exchange.getRuntimeFault() ?? control.fault)}`,
          };
        });
        // A read snapshot can predate a concurrent logout. Check current access
        // again immediately before publishing, outside the earlier snapshot.
        await this.exchange.readTransaction((tx) => requirePrincipal(tx, token));
        if (stopped) return;
        const changed = head.changed || (signature !== undefined && signature !== head.signature);
        cursor = head.cursor;
        sessionId = head.sessionId;
        signature = head.signature;
        const data = { sessionId, cursor };
        if (head.reset) send('reset', data, cursor);
        else if (changed) send('invalidate', data, cursor);
        else if (initial) send('ready', data, cursor);
        else if (performance.now() - lastSent >= this.options.heartbeatMs)
          send('heartbeat', data, cursor);
        initial = false;
      } catch (error) {
        if (error instanceof AuthError && (error.statusCode === 401 || error.statusCode === 403))
          send('auth-lost', {});
        else send('unavailable', {});
        close();
      }
      if (!stopped) timer = setTimeout(() => void tick(), this.options.pollMs);
    };
    // Starting after the route returns releases its ordinary HTTP admission slot.
    // The stream has its own fixed capacity and never retains a SQL transaction.
    timer = setTimeout(() => void tick(), 0);
  }

  close(): void {
    this.closed = true;
    for (const close of [...this.streams]) close();
  }
}
