import type { HistoryExportView } from '@sandbox/contracts';
import type { Exchange } from '../exchange.js';
import { AuthError } from '../auth/errors.js';
import { historyContext, scopedAccount } from './context.js';
import { EXPORT_DECIMALS, exportColumns, exportRows, type ExportFileName } from './export-rows.js';

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
    const admin = actor.role === 'ADMIN';
    const columns = exportColumns(Boolean(accountId), admin);
    // Preserve the small JSON endpoint's original CSV contract.
    columns['manifest.csv'] = ['sessionId', 'accountId', 'asOf', 'outboxCursor', 'scope'];
    if (accountId)
      columns['commands.csv'] = ['commandId', 'status', 'code', 'sequence', 'createdAt', 'orderId'];
    const names: ExportFileName[] = [
      'manifest.csv',
      'orders.csv',
      'fills.csv',
      'activity.csv',
      'commands.csv',
      'balances.csv',
      ...(admin ? ['audit.csv' as const] : []),
    ];
    const files: HistoryExportView['files'] = [];
    let retainedBytes = 0;
    for (const name of names) {
      const header = csvText(columns[name], [], EXPORT_DECIMALS);
      const chunks: string[] = [];
      let rowCount = 0;
      const retain = (text: string) => {
        const bytes = Buffer.byteLength(text, 'utf8');
        if (retainedBytes + bytes > EXPORT_BYTE_LIMIT)
          throw new AuthError(
            'EXPORT_TOO_LARGE',
            'This export exceeds the 5 MiB limit. Export a smaller session or account.',
            413,
          );
        retainedBytes += bytes;
        chunks.push(text);
      };
      const append = (rows: CsvRow[]) => {
        for (const row of rows) {
          if (rowCount >= EXPORT_ROW_LIMIT)
            throw new AuthError(
              'EXPORT_TOO_LARGE',
              `This export exceeds ${EXPORT_ROW_LIMIT} rows in one file. Export a smaller session or account.`,
              413,
            );
          // Check each encoded row before retaining it. Large audit records
          // cannot accumulate an oversized bundle or trigger later SQL pages.
          retain(csvText(columns[name], [row], EXPORT_DECIMALS).slice(header.length));
          rowCount += 1;
        }
      };
      retain(header);
      if (name === 'manifest.csv') {
        append([
          {
            sessionId,
            accountId,
            asOf,
            outboxCursor: cursor,
            scope: accountId ? 'ACCOUNT' : 'ADMIN_SESSION',
          },
        ]);
      } else {
        for await (const rows of exportRows(tx, sessionId, accountId, admin, name, () => undefined))
          append(rows);
      }
      files.push({ name, content: chunks.join('') });
    }
    return { sessionId, accountId, asOf, cursor, files };
  });
}
