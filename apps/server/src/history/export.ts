import type { HistoryExportView, HistoryPageQueryInput } from '@sandbox/contracts';
import { formatQuantity, formatQuote } from '@sandbox/domain';
import type { Exchange } from '../exchange.js';
import { AuthError } from '../auth/errors.js';
import { accountBalances, detailedOrders } from '../workspace.js';
import { fillView } from '../views.js';
import { historyContext, scopedAccount, type HistoryTransaction } from './context.js';
import { pageRows, receiptOrder } from './page.js';

export const EXPORT_ROW_LIMIT = 10000;
export const EXPORT_BYTE_LIMIT = 5 * 1024 * 1024;
type CsvRow = Record<string, unknown>;

/** Quote every field; only verified decimal fields bypass spreadsheet-formula protection. */
export function csvText(
  columns: string[],
  rows: CsvRow[],
  decimals: readonly string[] = [],
): string {
  const numeric = new Set(decimals);
  const cell = (value: unknown, key: string): string => {
    let text =
      value === null || value === undefined
        ? ''
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value);
    if (!(numeric.has(key) && /^-?[0-9]+(?:\.[0-9]+)?$/.test(text)) && /^[\s]*[=+\-@]/.test(text))
      text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  return (
    [
      columns.map((key) => cell(key, '')).join(','),
      ...rows.map((row) => columns.map((key) => cell(row[key], key)).join(',')),
    ].join('\r\n') + '\r\n'
  );
}

function bounded<T>(rows: T[]): T[] {
  if (rows.length > EXPORT_ROW_LIMIT)
    throw new AuthError(
      'EXPORT_TOO_LARGE',
      `This export exceeds ${EXPORT_ROW_LIMIT} rows in one file. Export a smaller session or account.`,
      413,
    );
  return rows;
}

async function globalFinancialFiles(
  tx: HistoryTransaction,
  sessionId: string,
): Promise<HistoryExportView['files']> {
  const rawOrders = bounded(
    await tx
      .selectFrom('orders')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('acceptance_sequence')
      .limit(EXPORT_ROW_LIMIT + 1)
      .execute(),
  );
  const orders = await detailedOrders(tx, rawOrders);
  const fills = bounded(
    await tx
      .selectFrom('fills')
      .innerJoin('orders as buy', 'buy.id', 'fills.buy_order_id')
      .innerJoin('orders as sell', 'sell.id', 'fills.sell_order_id')
      .selectAll('fills')
      .select(['buy.account_id as buyer_account_id', 'sell.account_id as seller_account_id'])
      .where('fills.session_id', '=', sessionId)
      .orderBy('sequence')
      .orderBy('fill_index')
      .limit(EXPORT_ROW_LIMIT + 1)
      .execute(),
  );
  const entries = bounded(
    await tx
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
      .where('journal_entries.session_id', '=', sessionId)
      .orderBy('journal_entries.id')
      .limit(EXPORT_ROW_LIMIT + 1)
      .execute(),
  );
  const receipts = bounded(
    await tx
      .selectFrom('receipts')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('sequence')
      .limit(EXPORT_ROW_LIMIT + 1)
      .execute(),
  );
  const balances = bounded(
    await tx
      .selectFrom('balances')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('account_id')
      .orderBy('asset')
      .orderBy('bucket')
      .limit(EXPORT_ROW_LIMIT + 1)
      .execute(),
  );
  const accountIds = [...new Set(balances.map((row) => row.account_id))];
  const byBucket = new Map(
    balances.map((row) => [`${row.account_id}:${row.asset}:${row.bucket}`, row.amount]),
  );
  const balanceRows = accountIds.flatMap((accountId) =>
    (['BTC-SIM', 'USD-SIM'] as const).map((asset) => {
      const available = BigInt(byBucket.get(`${accountId}:${asset}:AVAILABLE`) ?? '0');
      const reserved = BigInt(byBucket.get(`${accountId}:${asset}:RESERVED`) ?? '0');
      const format = asset === 'BTC-SIM' ? formatQuantity : formatQuote;
      return {
        accountId,
        asset,
        available: format(available),
        reserved: format(reserved),
        total: format(available + reserved),
      };
    }),
  );
  return [
    {
      name: 'orders.csv',
      content: csvText(
        [
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
        orders,
        [
          'quantity',
          'price',
          'remaining',
          'reserved',
          'sequence',
          'executedQuantity',
          'averagePrice',
          'cumulativeFee',
        ],
      ),
    },
    {
      name: 'fills.csv',
      content: csvText(
        [
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
        fills.map((row) => ({
          ...fillView(row),
          buyerAccountId: row.buyer_account_id,
          sellerAccountId: row.seller_account_id,
          timestamp: row.created_at.toISOString(),
        })),
        ['quantity', 'price', 'notional', 'buyerFee', 'sellerFee', 'sequence', 'fillIndex'],
      ),
    },
    {
      name: 'activity.csv',
      content: csvText(
        ['id', 'accountId', 'asset', 'bucket', 'amount', 'commandId', 'kind', 'createdAt'],
        entries.map((row) => ({
          id: row.id,
          accountId: row.account_id,
          asset: row.asset,
          bucket: row.bucket,
          amount: (row.asset === 'BTC-SIM' ? formatQuantity : formatQuote)(BigInt(row.amount)),
          commandId: row.command_id,
          kind: row.kind,
          createdAt: row.created_at.toISOString(),
        })),
        ['id', 'amount'],
      ),
    },
    {
      name: 'commands.csv',
      content: csvText(
        ['accountId', 'commandId', 'status', 'code', 'sequence', 'orderId', 'createdAt'],
        receipts.map((row) => ({
          accountId: row.actor_id,
          commandId: row.command_id,
          status: row.result.status,
          code: row.result.code,
          sequence: row.sequence,
          orderId: receiptOrder(row.result),
          createdAt: row.created_at.toISOString(),
        })),
        ['sequence'],
      ),
    },
    {
      name: 'balances.csv',
      content: csvText(
        ['accountId', 'asset', 'available', 'reserved', 'total'],
        bounded(balanceRows),
        ['available', 'reserved', 'total'],
      ),
    },
  ];
}

async function accountFinancialFiles(
  tx: HistoryTransaction,
  sessionId: string,
  accountId: string,
  admin: boolean,
): Promise<HistoryExportView['files']> {
  const files: HistoryExportView['files'] = [];
  const kinds = ['orders', 'fills', 'activity', 'commands'] as const;
  const columns = {
    orders: [
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
    fills: [
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
    ],
    activity: ['id', 'kind', 'asset', 'bucket', 'amount', 'commandId', 'orderId', 'createdAt'],
    commands: ['commandId', 'status', 'code', 'sequence', 'createdAt', 'orderId'],
  };
  for (const kind of kinds) {
    const result = await pageRows(
      tx,
      sessionId,
      accountId,
      { kind },
      `export:${kind}`,
      EXPORT_ROW_LIMIT,
      admin,
    );
    if (result.nextCursor)
      throw new AuthError(
        'EXPORT_TOO_LARGE',
        `This export exceeds ${EXPORT_ROW_LIMIT} rows in one file. Export a smaller session or account.`,
        413,
      );
    files.push({
      name: `${kind}.csv`,
      content: csvText(columns[kind], result.items, [
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
        'fillIndex',
        'amount',
        'id',
      ]),
    });
  }
  // Same transaction as every history file: balances cannot drift between downloads.
  const balances = await accountBalances(tx, sessionId, accountId);
  files.push({
    name: 'balances.csv',
    content: csvText(
      ['accountId', 'asset', 'available', 'reserved', 'total'],
      Object.entries(balances).map(([asset, balance]) => ({
        accountId,
        asset,
        ...balance,
      })),
      ['available', 'reserved', 'total'],
    ),
  });
  return files;
}

export async function historyExport(
  exchange: Exchange,
  token: string,
  sessionId: string,
  requestedAccountId?: string,
): Promise<HistoryExportView> {
  return exchange.readTransaction(async (tx) => {
    const { actor, asOf, cursor } = await historyContext(tx, token, sessionId);
    const accountId =
      actor.role === 'ADMIN' && !requestedAccountId
        ? null
        : await scopedAccount(tx, actor, requestedAccountId);
    const files = accountId
      ? await accountFinancialFiles(tx, sessionId, accountId, actor.role === 'ADMIN')
      : await globalFinancialFiles(tx, sessionId);
    if (actor.role === 'ADMIN') {
      const audit = await pageRows(
        tx,
        sessionId,
        null,
        { kind: 'audit' } satisfies HistoryPageQueryInput,
        'export:audit',
        EXPORT_ROW_LIMIT,
        true,
      );
      if (audit.nextCursor)
        throw new AuthError(
          'EXPORT_TOO_LARGE',
          `This export exceeds ${EXPORT_ROW_LIMIT} rows in one file. Export a smaller session or account.`,
          413,
        );
      files.push({
        name: 'audit.csv',
        content: csvText(
          [
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
          audit.items,
        ),
      });
    }
    files.unshift({
      name: 'manifest.csv',
      content: csvText(
        ['sessionId', 'accountId', 'asOf', 'outboxCursor', 'scope'],
        [
          {
            sessionId,
            accountId,
            asOf,
            outboxCursor: cursor,
            scope: accountId ? 'ACCOUNT' : 'ADMIN_SESSION',
          },
        ],
        ['outboxCursor'],
      ),
    });
    if (
      files.reduce((bytes, file) => bytes + Buffer.byteLength(file.content, 'utf8'), 0) >
      EXPORT_BYTE_LIMIT
    )
      throw new AuthError(
        'EXPORT_TOO_LARGE',
        'This export exceeds the 5 MiB limit. Export a smaller session or account.',
        413,
      );
    return { sessionId, accountId, asOf, cursor, files };
  });
}
