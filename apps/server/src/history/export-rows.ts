import { formatQuantity, formatQuote } from '@sandbox/domain';
import { sql } from 'kysely';
import { accountBalances, detailedOrders } from '../workspace.js';
import { fillView } from '../views.js';
import type { HistoryTransaction } from './context.js';
import { pageRows, receiptOrder } from './page.js';

export const EXPORT_BATCH_SIZE = 500;
export type ExportFileName =
  | 'manifest.csv'
  | 'orders.csv'
  | 'fills.csv'
  | 'activity.csv'
  | 'commands.csv'
  | 'balances.csv'
  | 'audit.csv';
export type ExportRow = Record<string, unknown>;
export const EXPORT_DECIMALS = [
  'quantity',
  'price',
  'remaining',
  'reserved',
  'sequence',
  'executedQuantity',
  'averagePrice',
  'cumulativeFee',
  'notional',
  'fee',
  'buyerFee',
  'sellerFee',
  'fillIndex',
  'amount',
  'id',
  'available',
  'reserved',
  'total',
  'outboxCursor',
] as const;

export function exportColumns(account: boolean, admin: boolean): Record<ExportFileName, string[]> {
  return {
    'manifest.csv': [
      'sessionId',
      'accountId',
      'asOf',
      'outboxCursor',
      'scope',
      'auditScope',
      'baseAsset',
      'quoteAsset',
    ],
    'orders.csv': [
      'id',
      'accountId',
      'type',
      'side',
      'quantity',
      'price',
      'remaining',
      'reserved',
      'status',
      'cancelReason',
      'sequence',
      'executedQuantity',
      'averagePrice',
      'cumulativeFee',
      'createdAt',
      'updatedAt',
    ],
    'fills.csv': account
      ? [
          'id',
          'orderId',
          'side',
          'role',
          ...(admin ? ['makerOrderId', 'takerOrderId', 'buyOrderId', 'sellOrderId'] : []),
          'quantity',
          'price',
          'notional',
          'fee',
          'sequence',
          'fillIndex',
          'timestamp',
        ]
      : [
          'id',
          'buyerAccountId',
          'sellerAccountId',
          'makerOrderId',
          'takerOrderId',
          'buyOrderId',
          'sellOrderId',
          'quantity',
          'price',
          'notional',
          'buyerFee',
          'sellerFee',
          'sequence',
          'fillIndex',
          'timestamp',
        ],
    'activity.csv': account
      ? ['id', 'kind', 'asset', 'bucket', 'amount', 'commandId', 'orderId', 'createdAt']
      : ['id', 'accountId', 'asset', 'bucket', 'amount', 'commandId', 'kind', 'createdAt'],
    'commands.csv': [
      ...(!account ? ['accountId'] : []),
      'commandId',
      'status',
      'code',
      'sequence',
      'orderId',
      'createdAt',
    ],
    'balances.csv': ['accountId', 'asset', 'available', 'reserved', 'total'],
    'audit.csv': [
      'id',
      'actorId',
      'commandId',
      'sessionId',
      'action',
      'targetId',
      'reason',
      'result',
      'createdAt',
    ],
  };
}

/** Every yielded page is bounded; the caller keeps the same PostgreSQL snapshot throughout. */
export async function* exportRows(
  tx: HistoryTransaction,
  sessionId: string,
  accountId: string | null,
  admin: boolean,
  file: Exclude<ExportFileName, 'manifest.csv'>,
  check: () => void,
): AsyncGenerator<ExportRow[]> {
  if (file === 'balances.csv') {
    if (accountId) {
      check();
      const balances = await accountBalances(tx, sessionId, accountId);
      yield Object.entries(balances).map(([asset, balance]) => ({ accountId, asset, ...balance }));
      return;
    }
    let after: string | undefined;
    while (true) {
      check();
      let selection = tx
        .selectFrom('balances')
        .select('account_id')
        .distinct()
        .where('session_id', '=', sessionId);
      if (after) selection = selection.where('account_id', '>', after);
      const accounts = await selection
        .orderBy('account_id')
        .limit(EXPORT_BATCH_SIZE / 2)
        .execute();
      if (!accounts.length) return;
      const ids = accounts.map((row) => row.account_id);
      const balances = await tx
        .selectFrom('balances')
        .selectAll()
        .where('session_id', '=', sessionId)
        .where('account_id', 'in', ids)
        .execute();
      const buckets = new Map(
        balances.map((row) => [`${row.account_id}:${row.asset}:${row.bucket}`, row.amount]),
      );
      yield ids.flatMap((id) =>
        (['BTC-SIM', 'USD-SIM'] as const).map((asset) => {
          const available = BigInt(buckets.get(`${id}:${asset}:AVAILABLE`) ?? '0');
          const reserved = BigInt(buckets.get(`${id}:${asset}:RESERVED`) ?? '0');
          const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
          return {
            accountId: id,
            asset,
            available: format(available),
            reserved: format(reserved),
            total: format(available + reserved),
          };
        }),
      );
      after = ids.at(-1)!;
    }
  }
  const kind = file.slice(0, -4) as 'orders' | 'fills' | 'activity' | 'commands' | 'audit';
  if (accountId || kind === 'audit') {
    let cursor: string | undefined;
    do {
      check();
      const page = await pageRows(
        tx,
        sessionId,
        accountId,
        { kind, ...(cursor ? { cursor } : {}) },
        `prepared-export:${file}`,
        EXPORT_BATCH_SIZE,
        admin,
      );
      yield page.items.map((row) => ({ ...row }));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return;
  }
  // Session-wide keysets include all identity tie breakers, including rejected receipt sequences.
  if (kind === 'orders') {
    let after: string | undefined;
    while (true) {
      check();
      let selection = tx.selectFrom('orders').selectAll().where('session_id', '=', sessionId);
      if (after) selection = selection.where('acceptance_sequence', '>', after);
      const rows = await selection
        .orderBy('acceptance_sequence')
        .limit(EXPORT_BATCH_SIZE)
        .execute();
      if (!rows.length) return;
      yield (await detailedOrders(tx, rows)).map((row) => ({ ...row }));
      after = rows.at(-1)!.acceptance_sequence;
    }
  } else if (kind === 'fills') {
    let after: { sequence: string; fill_index: number } | undefined;
    while (true) {
      check();
      let selection = tx
        .selectFrom('fills')
        .innerJoin('orders as buy', 'buy.id', 'fills.buy_order_id')
        .innerJoin('orders as sell', 'sell.id', 'fills.sell_order_id')
        .selectAll('fills')
        .select(['buy.account_id as buyer_account_id', 'sell.account_id as seller_account_id'])
        .where('fills.session_id', '=', sessionId);
      if (after)
        selection = selection.where(
          sql<boolean>`(fills.sequence, fills.fill_index) > (${after.sequence}::bigint, ${after.fill_index}::integer)`,
        );
      const rows = await selection
        .orderBy('fills.sequence')
        .orderBy('fills.fill_index')
        .limit(EXPORT_BATCH_SIZE)
        .execute();
      if (!rows.length) return;
      yield rows.map((row) => ({
        ...fillView(row),
        buyerAccountId: row.buyer_account_id,
        sellerAccountId: row.seller_account_id,
        timestamp: row.created_at.toISOString(),
      }));
      after = rows.at(-1)!;
    }
  } else if (kind === 'activity') {
    let after: string | undefined;
    while (true) {
      check();
      let selection = tx
        .selectFrom('journal_entries')
        .innerJoin(
          'journal_transactions',
          'journal_transactions.id',
          'journal_entries.journal_transaction_id',
        )
        .select([
          'journal_entries.id',
          'journal_entries.account_id',
          'journal_entries.asset',
          'journal_entries.bucket',
          'journal_entries.amount',
          'journal_transactions.command_id',
          'journal_transactions.kind',
          'journal_transactions.created_at',
        ])
        .where('journal_entries.session_id', '=', sessionId);
      if (after) selection = selection.where('journal_entries.id', '>', after);
      const rows = await selection.orderBy('journal_entries.id').limit(EXPORT_BATCH_SIZE).execute();
      if (!rows.length) return;
      yield rows.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        asset: row.asset,
        bucket: row.bucket,
        amount: (row.asset === 'BTC-SIM' ? formatQuantity : formatQuote)(BigInt(row.amount)),
        commandId: row.command_id,
        kind: row.kind,
        createdAt: row.created_at.toISOString(),
      }));
      after = rows.at(-1)!.id;
    }
  } else {
    let after: { sequence: string; command_id: string; actor_id: string } | undefined;
    while (true) {
      check();
      let selection = tx.selectFrom('receipts').selectAll().where('session_id', '=', sessionId);
      if (after)
        selection = selection.where(
          sql<boolean>`(sequence, command_id, actor_id) > (${after.sequence}::bigint, ${after.command_id}::uuid, ${after.actor_id}::uuid)`,
        );
      const rows = await selection
        .orderBy('sequence')
        .orderBy('command_id')
        .orderBy('actor_id')
        .limit(EXPORT_BATCH_SIZE)
        .execute();
      if (!rows.length) return;
      yield rows.map((row) => ({
        accountId: row.actor_id,
        commandId: row.command_id,
        status: row.result.status,
        code: row.result.code,
        sequence: row.sequence,
        orderId: receiptOrder(row.result),
        createdAt: row.created_at.toISOString(),
      }));
      after = rows.at(-1)!;
    }
  }
}
