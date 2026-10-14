import type { HistoryPageQueryInput, HistoryPageView } from '@sandbox/contracts';
import { formatQuantity, formatQuote } from '@sandbox/domain';
import { sql } from 'kysely';
import type { Exchange } from '../exchange.js';
import { AuthError } from '../auth/errors.js';
import { detailedOrders, ownerFill } from '../workspace.js';
import {
  decimalPosition,
  decodeCursor,
  encodeCursor,
  historyContext,
  scopedAccount,
  textPattern,
  pageLimit,
  timestampPosition,
  uuidPosition,
  type HistoryTransaction,
} from './context.js';

type PageItem = HistoryPageView['items'][number];
export function receiptOrder(value: Record<string, unknown>): string | null {
  const order = value.order;
  return order && typeof order === 'object' && 'id' in order && typeof order.id === 'string'
    ? order.id
    : null;
}

/** Keyset reads keep every record reachable. An active session is read anew on each request. */
export async function pageRows(
  tx: HistoryTransaction,
  sessionId: string,
  accountId: string | null,
  query: HistoryPageQueryInput,
  context: string,
  limit: number,
  admin = false,
): Promise<{ items: PageItem[]; nextCursor: string | null }> {
  const kind = query.kind;
  const fields = kind === 'fills' || kind === 'audit' || kind === 'commands' ? 2 : 1;
  const position = decodeCursor(query.cursor, context, fields);
  if (kind !== 'audit') decimalPosition(position, kind === 'fills' ? [0, 1] : [0]);
  if (kind === 'fills' && position && BigInt(position[1]!) > 2147483647n)
    throw new AuthError('CURSOR_INVALID', 'Fill cursor index is invalid.', 400);
  if (kind === 'commands') uuidPosition(position, 1);
  if ((query.side || query.status) && kind !== 'orders')
    throw new AuthError('FILTER_INVALID', 'Side and status filters apply to orders.', 400);
  const search = query.search?.trim();
  let items: PageItem[];
  let lastPosition: string[] | undefined;
  let hasMore: boolean;
  if (kind === 'orders') {
    let selection = tx
      .selectFrom('orders')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('account_id', '=', accountId!);
    if (position) selection = selection.where('acceptance_sequence', '<', position[0]!);
    if (query.side) selection = selection.where('side', '=', query.side);
    if (query.status) selection = selection.where('status', '=', query.status);
    if (search) selection = selection.where(sql<boolean>`id::text ILIKE ${textPattern(search)}`);
    const rows = await selection
      .orderBy('acceptance_sequence', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    items = await detailedOrders(tx, page);
    hasMore = rows.length > limit;
    const last = page.at(-1);
    lastPosition = last ? [last.acceptance_sequence] : undefined;
  } else if (kind === 'fills') {
    let selection = tx
      .selectFrom('fills')
      .innerJoin('orders', (join) =>
        join.on((eb) =>
          eb.or([
            eb('orders.id', '=', eb.ref('fills.buy_order_id')),
            eb('orders.id', '=', eb.ref('fills.sell_order_id')),
          ]),
        ),
      )
      .selectAll('fills')
      .select(['orders.id as owner_order_id', 'orders.side as owner_side'])
      .where('fills.session_id', '=', sessionId)
      .where('orders.account_id', '=', accountId!);
    if (position)
      selection = selection.where(
        sql<boolean>`(fills.sequence, fills.fill_index) < (${position[0]}::bigint, ${position[1]}::integer)`,
      );
    if (search)
      selection = selection.where((eb) =>
        eb.or([
          sql<boolean>`fills.id::text ILIKE ${textPattern(search)}`,
          sql<boolean>`orders.id::text ILIKE ${textPattern(search)}`,
        ]),
      );
    const rows = await selection
      .orderBy('fills.sequence', 'desc')
      .orderBy('fills.fill_index', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    items = page.map((fill) => ({
      ...ownerFill(fill, { id: fill.owner_order_id, side: fill.owner_side }),
      ...(admin
        ? {
            makerOrderId: fill.maker_order_id,
            takerOrderId: fill.taker_order_id,
            buyOrderId: fill.buy_order_id,
            sellOrderId: fill.sell_order_id,
          }
        : {}),
    }));
    hasMore = rows.length > limit;
    const last = page.at(-1);
    lastPosition = last ? [last.sequence, String(last.fill_index)] : undefined;
  } else if (kind === 'activity') {
    let selection = tx
      .selectFrom('journal_entries')
      .innerJoin(
        'journal_transactions',
        'journal_transactions.id',
        'journal_entries.journal_transaction_id',
      )
      .select([
        'journal_entries.id',
        'journal_entries.asset',
        'journal_entries.bucket',
        'journal_entries.amount',
        'journal_transactions.command_id',
        'journal_transactions.kind',
        'journal_transactions.created_at',
      ])
      .where('journal_entries.session_id', '=', sessionId)
      .where('journal_entries.account_id', '=', accountId!);
    if (position) selection = selection.where('journal_entries.id', '<', position[0]!);
    if (search)
      selection = selection.where((eb) =>
        eb.or([
          eb('journal_transactions.kind', 'ilike', textPattern(search)),
          sql<boolean>`journal_entries.id::text ILIKE ${textPattern(search)}`,
        ]),
      );
    const rows = await selection
      .orderBy('journal_entries.id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    const commandIds = [...new Set(page.map((row) => row.command_id))];
    const receipts = commandIds.length
      ? await tx
          .selectFrom('receipts')
          .select(['command_id', 'result'])
          .where('actor_id', '=', accountId!)
          .where('command_id', 'in', commandIds)
          .execute()
      : [];
    const byCommand = new Map(receipts.map((row) => [row.command_id, receiptOrder(row.result)]));
    items = page.map((row) => ({
      id: row.id,
      kind: row.kind,
      asset: row.asset,
      bucket: row.bucket,
      amount: (row.asset === 'BTC-SIM' ? formatQuantity : formatQuote)(BigInt(row.amount)),
      commandId: admin || byCommand.has(row.command_id) ? row.command_id : null,
      orderId: byCommand.get(row.command_id) ?? null,
      createdAt: row.created_at.toISOString(),
    }));
    hasMore = rows.length > limit;
    const last = page.at(-1);
    lastPosition = last ? [last.id] : undefined;
  } else if (kind === 'commands') {
    let selection = tx
      .selectFrom('receipts')
      .selectAll()
      .where('session_id', '=', sessionId)
      .where('actor_id', '=', accountId!)
      .where(sql<boolean>`result->>'status' IN ('ACCEPTED', 'REJECTED')`);
    if (position)
      selection = selection.where(
        sql<boolean>`(sequence, command_id) < (${position[0]}::bigint, ${position[1]}::uuid)`,
      );
    if (search)
      selection = selection.where((eb) =>
        eb.or([
          sql<boolean>`command_id::text ILIKE ${textPattern(search)}`,
          sql<boolean>`result->>'code' ILIKE ${textPattern(search)}`,
        ]),
      );
    const rows = await selection
      .orderBy('sequence', 'desc')
      .orderBy('command_id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    items = page.map((row) => ({
      commandId: row.command_id,
      status: row.result.status as 'ACCEPTED' | 'REJECTED',
      code: typeof row.result.code === 'string' ? row.result.code : null,
      sequence: row.sequence,
      createdAt: row.created_at.toISOString(),
      orderId: receiptOrder(row.result),
    }));
    hasMore = rows.length > limit;
    const last = page.at(-1);
    lastPosition = last ? [last.sequence, last.command_id] : undefined;
  } else {
    let selection = tx
      .selectFrom('admin_audit')
      .selectAll()
      .select(
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'cursor_timestamp',
        ),
      )
      .where('session_id', '=', sessionId);
    if (position) {
      timestampPosition(position);
      uuidPosition(position, 1);
      selection = selection.where(
        sql<boolean>`(created_at, id) < (${position[0]}::timestamptz, ${position[1]}::uuid)`,
      );
    }
    if (search)
      selection = selection.where((eb) =>
        eb.or([
          eb('action', 'ilike', textPattern(search)),
          eb('reason', 'ilike', textPattern(search)),
          sql<boolean>`id::text ILIKE ${textPattern(search)}`,
          sql<boolean>`command_id::text ILIKE ${textPattern(search)}`,
          sql<boolean>`target_id::text ILIKE ${textPattern(search)}`,
        ]),
      );
    const rows = await selection
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const page = rows.slice(0, limit);
    items = page.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      commandId: row.command_id,
      sessionId: row.session_id,
      action: row.action,
      targetId: row.target_id,
      reason: row.reason,
      result: row.result,
      createdAt: row.created_at.toISOString(),
    }));
    hasMore = rows.length > limit;
    const last = page.at(-1);
    lastPosition = last ? [last.cursor_timestamp, last.id] : undefined;
  }
  return {
    items,
    nextCursor: hasMore && lastPosition ? encodeCursor(context, lastPosition) : null,
  };
}

export async function historyPage(
  exchange: Exchange,
  token: string,
  sessionId: string,
  query: HistoryPageQueryInput,
): Promise<HistoryPageView> {
  return exchange.readTransaction(async (tx) => {
    const { actor, asOf } = await historyContext(tx, token, sessionId);
    if (query.kind === 'audit' && actor.role !== 'ADMIN')
      throw new AuthError('FORBIDDEN', 'Audit history requires administrator access.', 403);
    if (query.kind === 'audit' && query.accountId)
      throw new AuthError('FILTER_INVALID', 'Audit history is scoped to the session.', 400);
    const accountId =
      query.kind === 'audit' ? null : await scopedAccount(tx, actor, query.accountId);
    const context = JSON.stringify([
      sessionId,
      actor.accountId,
      actor.role,
      accountId,
      query.kind,
      query.search?.trim() ?? '',
      query.side ?? '',
      query.status ?? '',
    ]);
    return {
      sessionId,
      accountId,
      kind: query.kind,
      asOf,
      ...(await pageRows(
        tx,
        sessionId,
        accountId,
        query,
        context,
        pageLimit(query.limit),
        actor.role === 'ADMIN',
      )),
    };
  });
}
