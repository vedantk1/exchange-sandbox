import type {
  AccountView,
  WorkspaceView,
  WorkspaceOrderView,
  WorkspaceFillView,
} from '@sandbox/contracts';
import type { Database } from '@sandbox/database';
import { formatPrice, formatQuantity, formatQuote } from '@sandbox/domain';
import { sql, type Selectable, type Transaction } from 'kysely';
import { requirePrincipal } from './auth/access.js';
import { AuthError } from './auth/errors.js';
import type { Exchange } from './exchange.js';
import { fillView, orderView } from './views.js';

export const HISTORY_LIMIT = 100;
type Tx = Transaction<Database>;
type OrderRow = Selectable<Database['orders']>;
type FillRow = Selectable<Database['fills']>;

export async function currentCursor(tx: Tx, sessionId: string): Promise<string> {
  const result = await tx
    .selectFrom('outbox')
    .select(sql<string>`coalesce(max(id), 0)::text`.as('cursor'))
    .where('session_id', '=', sessionId)
    .executeTakeFirstOrThrow();
  return result.cursor;
}

export function ownerFill(fill: FillRow, order: Pick<OrderRow, 'id' | 'side'>): WorkspaceFillView {
  const {
    makerOrderId: _maker,
    takerOrderId: _taker,
    buyOrderId: _buy,
    sellOrderId: _sell,
    ...safe
  } = fillView(fill);
  return {
    ...safe,
    orderId: order.id,
    side: order.side,
    role: fill.maker_order_id === order.id ? 'MAKER' : 'TAKER',
    timestamp: fill.created_at.toISOString(),
    fee: formatQuote(BigInt(order.side === 'BUY' ? fill.buyer_fee : fill.seller_fee)),
  };
}

export async function detailedOrders(tx: Tx, rows: OrderRow[]): Promise<WorkspaceOrderView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const totals = await sql<{ order_id: string; quantity: string; notional: string; fee: string }>`
    SELECT o.id AS order_id, coalesce(sum(f.quantity), 0)::text AS quantity,
      coalesce(sum(f.notional), 0)::text AS notional,
      coalesce(sum(CASE WHEN o.side = 'BUY' THEN f.buyer_fee ELSE f.seller_fee END), 0)::text AS fee
    FROM orders o LEFT JOIN fills f ON f.buy_order_id = o.id OR f.sell_order_id = o.id
    WHERE o.id = ANY(${ids}::uuid[]) GROUP BY o.id`.execute(tx);
  const byId = new Map(totals.rows.map((row) => [row.order_id, row]));
  return rows.map((row) => {
    const total = byId.get(row.id)!;
    const quantity = BigInt(total.quantity);
    // Weighted average is display-only: round half up to nine decimals using integers.
    const average =
      quantity === 0n
        ? null
        : formatQuote((BigInt(total.notional) * 10000n + quantity / 2n) / quantity);
    return {
      ...orderView(row),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      executedQuantity: formatQuantity(quantity),
      averagePrice: average,
      cumulativeFee: formatQuote(BigInt(total.fee)),
    };
  });
}

export async function accountWorkspace(
  tx: Tx,
  sessionId: string,
  accountId: string,
  admin = false,
): Promise<AccountView> {
  const balances = await tx
    .selectFrom('balances')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('account_id', '=', accountId)
    .execute();
  const balance = (asset: 'BTC-SIM' | 'USD-SIM') => {
    const available = BigInt(
      balances.find((row) => row.asset === asset && row.bucket === 'AVAILABLE')?.amount ?? '0',
    );
    const reserved = BigInt(
      balances.find((row) => row.asset === asset && row.bucket === 'RESERVED')?.amount ?? '0',
    );
    const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
    return {
      available: format(available),
      reserved: format(reserved),
      total: format(available + reserved),
    };
  };
  const baseOrders = tx
    .selectFrom('orders')
    .selectAll()
    .where('session_id', '=', sessionId)
    .where('account_id', '=', accountId);
  const recent = await baseOrders
    .orderBy('acceptance_sequence', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  const open = await baseOrders
    .where('status', 'in', ['OPEN', 'PARTIALLY_FILLED'])
    .orderBy('acceptance_sequence', 'desc')
    .execute();
  const all = [...new Map([...recent, ...open].map((row) => [row.id, row])).values()];
  const detailed = new Map((await detailedOrders(tx, all)).map((order) => [order.id, order]));
  const fills = await tx
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
    .where('orders.account_id', '=', accountId)
    .orderBy('fills.sequence', 'desc')
    .orderBy('fills.fill_index', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  const entries = await tx
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
    .where('journal_entries.account_id', '=', accountId)
    .orderBy('journal_entries.id', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  const receipts = await tx
    .selectFrom('receipts')
    .selectAll()
    .where('actor_id', '=', accountId)
    .where('session_id', '=', sessionId)
    .orderBy('sequence', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  const receiptOrder = (value: Record<string, unknown>): string | null => {
    const order = value.order;
    return order && typeof order === 'object' && 'id' in order && typeof order.id === 'string'
      ? order.id
      : null;
  };
  const commandIds = [...new Set(entries.map((row) => row.command_id))];
  const entryReceipts = commandIds.length
    ? await tx
        .selectFrom('receipts')
        .select(['command_id', 'result'])
        .where('actor_id', '=', accountId)
        .where('command_id', 'in', commandIds)
        .execute()
    : [];
  const orderByCommand = new Map(
    entryReceipts.map((row) => [row.command_id, receiptOrder(row.result)]),
  );
  return {
    balances: { 'BTC-SIM': balance('BTC-SIM'), 'USD-SIM': balance('USD-SIM') },
    openOrders: open.map((row) => detailed.get(row.id)!),
    orders: recent.map((row) => detailed.get(row.id)!),
    fills: fills.map((fill) => ({
      ...ownerFill(fill, { id: fill.owner_order_id, side: fill.owner_side }),
      ...(admin
        ? {
            makerOrderId: fill.maker_order_id,
            takerOrderId: fill.taker_order_id,
            buyOrderId: fill.buy_order_id,
            sellOrderId: fill.sell_order_id,
          }
        : {}),
    })),
    activity: entries.map((row) => ({
      id: row.id,
      kind: row.kind,
      asset: row.asset,
      bucket: row.bucket,
      amount: (row.asset === 'BTC-SIM' ? formatQuantity : formatQuote)(BigInt(row.amount)),
      commandId: admin || orderByCommand.has(row.command_id) ? row.command_id : null,
      orderId: orderByCommand.get(row.command_id) ?? null,
      createdAt: row.created_at.toISOString(),
    })),
    commands: receipts
      .filter((row) => row.result.status === 'ACCEPTED' || row.result.status === 'REJECTED')
      .map((row) => ({
        commandId: row.command_id,
        status: row.result.status as 'ACCEPTED' | 'REJECTED',
        code: typeof row.result.code === 'string' ? row.result.code : null,
        sequence: row.sequence,
        createdAt: row.created_at.toISOString(),
        orderId: receiptOrder(row.result),
      })),
    historyLimit: HISTORY_LIMIT,
  };
}

export async function marketWorkspace(tx: Tx, sessionId: string): Promise<WorkspaceView['market']> {
  const side = async (side: 'BUY' | 'SELL') => {
    const levels = await tx
      .selectFrom('orders')
      .select(['price', sql<string>`sum(remaining_quantity)`.as('quantity')])
      .where('session_id', '=', sessionId)
      .where('side', '=', side)
      .where('status', 'in', ['OPEN', 'PARTIALLY_FILLED'])
      .groupBy('price')
      .orderBy('price', side === 'BUY' ? 'desc' : 'asc')
      .limit(50)
      .execute();
    return levels.map((row) => ({
      price: formatPrice(BigInt(row.price)),
      quantity: formatQuantity(BigInt(row.quantity)),
    }));
  };
  const bids = await side('BUY');
  const asks = await side('SELL');
  const trades = await tx
    .selectFrom('fills')
    .selectAll()
    .where('session_id', '=', sessionId)
    .orderBy('sequence', 'desc')
    .orderBy('fill_index', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  // Aggregate full minute buckets before limiting. Never infer candles from a truncated trade list.
  const candles = await sql<{
    timestamp: Date;
    open: string;
    high: string;
    low: string;
    close: string;
    volume: string;
  }>`
    SELECT date_trunc('minute', created_at) AS timestamp,
      (array_agg(price ORDER BY sequence, fill_index))[1]::text AS open,
      max(price)::text AS high, min(price)::text AS low,
      (array_agg(price ORDER BY sequence DESC, fill_index DESC))[1]::text AS close,
      sum(quantity)::text AS volume FROM fills WHERE session_id = ${sessionId}::uuid
    GROUP BY date_trunc('minute', created_at) ORDER BY timestamp DESC LIMIT 60`.execute(tx);
  return {
    book: { bids, asks },
    trades: trades.map((fill) => ({
      price: formatPrice(BigInt(fill.price)),
      quantity: formatQuantity(BigInt(fill.quantity)),
      sequence: fill.sequence,
      fillIndex: fill.fill_index,
      timestamp: fill.created_at.toISOString(),
    })),
    candles: candles.rows.reverse().map((row) => ({
      timestamp: row.timestamp.toISOString(),
      open: formatPrice(BigInt(row.open)),
      high: formatPrice(BigInt(row.high)),
      low: formatPrice(BigInt(row.low)),
      close: formatPrice(BigInt(row.close)),
      volume: formatQuantity(BigInt(row.volume)),
    })),
  };
}

async function adminWorkspace(
  tx: Tx,
  sessionId: string,
  marketState: string,
  fault: string | null,
  demoMarket: NonNullable<WorkspaceView['admin']>['overview']['demoMarket'],
): Promise<NonNullable<WorkspaceView['admin']>> {
  const counts = await sql<{
    traders: string;
    suspended: string;
    pending: string;
    open_orders: string;
  }>`
    SELECT (SELECT count(*)::text FROM users WHERE role = 'TRADER') AS traders,
      (SELECT count(*)::text FROM users WHERE status = 'SUSPENDED') AS suspended,
      (SELECT count(*)::text FROM users WHERE pending_cancellation) AS pending,
      (SELECT count(*)::text FROM orders WHERE session_id = ${sessionId}::uuid AND status IN ('OPEN','PARTIALLY_FILLED')) AS open_orders`.execute(
    tx,
  );
  const system = await tx
    .selectFrom('accounts')
    .select(['id', 'kind'])
    .where('kind', 'in', ['FEE', 'ISSUANCE'])
    .execute();
  const traders = await tx
    .selectFrom('users')
    .select([
      'account_id',
      'handle',
      'status',
      'suspension_reason',
      'pending_cancellation',
      'created_at',
    ])
    .where('role', '=', 'TRADER')
    .orderBy('handle')
    .limit(200)
    .execute();
  const invitations = await tx
    .selectFrom('invitations')
    .select(['id', 'created_at', 'expires_at', 'revoked_at', 'redeemed_at', 'redeemed_by'])
    .select(sql<boolean>`expires_at <= current_timestamp`.as('expired'))
    .orderBy('created_at', 'desc')
    .limit(200)
    .execute();
  const audit = await tx
    .selectFrom('admin_audit')
    .selectAll()
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(HISTORY_LIMIT)
    .execute();
  return {
    overview: {
      sessionId,
      marketState,
      fault,
      counts: counts.rows[0]!,
      feeAccountId: system.find((row) => row.kind === 'FEE')?.id ?? null,
      issuanceAccountId: system.find((row) => row.kind === 'ISSUANCE')?.id ?? null,
      ...(demoMarket ? { demoMarket } : {}),
    },
    traders: traders.map((row) => ({
      accountId: row.account_id,
      handle: row.handle,
      status: row.status,
      suspensionReason: row.suspension_reason,
      pendingCancellation: row.pending_cancellation,
      createdAt: row.created_at.toISOString(),
    })),
    invitations: invitations.map((row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      state: row.redeemed_at
        ? 'REDEEMED'
        : row.revoked_at
          ? 'REVOKED'
          : row.expired
            ? 'EXPIRED'
            : 'PENDING',
      redeemedBy: row.redeemed_by,
    })),
    audit: audit.map((row) => ({
      id: row.id,
      actorId: row.actor_id,
      commandId: row.command_id,
      sessionId: row.session_id,
      action: row.action,
      targetId: row.target_id,
      reason: row.reason,
      result: row.result,
      createdAt: row.created_at.toISOString(),
    })),
  };
}

export async function workspaceSnapshot(exchange: Exchange, token: string): Promise<WorkspaceView> {
  return exchange.readTransaction(async (tx) => {
    const { accountId, handle, role } = await requirePrincipal(tx, token);
    const control = await tx
      .selectFrom('exchange_control')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (!control.active_session_id)
      throw new AuthError('NOT_BOOTSTRAPPED', 'Complete administrator setup first.', 503);
    const sessionId = control.active_session_id;
    const storedFault = exchange.getRuntimeFault() ?? control.fault;
    const fault = role === 'ADMIN' ? storedFault : storedFault ? 'ACCOUNTING_FAULT' : null;
    const cursor = await currentCursor(tx, sessionId);
    const demo = await tx
      .selectFrom('demo_market')
      .select(['enabled', 'status', 'updated_at', 'maker_account_id', 'taker_account_id'])
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const demoMarket = demo
      ? {
          enabled: demo.enabled,
          status:
            demo.enabled && storedFault
              ? 'FAULTED'
              : demo.enabled && control.market_state === 'PAUSED'
                ? 'PAUSED'
                : demo.status,
          updatedAt: demo.updated_at.toISOString(),
        }
      : undefined;
    return {
      user: { accountId, handle, role },
      sessionId,
      marketState: control.market_state,
      fault,
      cursor,
      market: {
        ...(await marketWorkspace(tx, sessionId)),
        ...(demoMarket ? { demoMarket } : {}),
      },
      historyLimit: HISTORY_LIMIT,
      ...(role === 'TRADER'
        ? { account: await accountWorkspace(tx, sessionId, accountId) }
        : {
            admin: await adminWorkspace(
              tx,
              sessionId,
              control.market_state,
              fault,
              demo && demoMarket
                ? {
                    ...demoMarket,
                    makerAccountId: demo.maker_account_id,
                    takerAccountId: demo.taker_account_id,
                  }
                : undefined,
            ),
          }),
    };
  });
}

export async function inspectAccount(
  exchange: Exchange,
  token: string,
  accountId: string,
): Promise<AccountView> {
  return exchange.readTransaction(async (tx) => {
    await requirePrincipal(tx, token, 'ADMIN');
    const account = await tx
      .selectFrom('accounts')
      .select('id')
      .where('id', '=', accountId)
      .where('kind', 'in', ['TRADER', 'FEE', 'ISSUANCE'])
      .executeTakeFirst();
    if (!account) throw new AuthError('ACCOUNT_NOT_FOUND', 'Account not found.', 404);
    const control = await tx
      .selectFrom('exchange_control')
      .select('active_session_id')
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (!control.active_session_id)
      throw new AuthError('NOT_BOOTSTRAPPED', 'Complete administrator setup first.', 503);
    return accountWorkspace(tx, control.active_session_id, accountId, true);
  });
}
