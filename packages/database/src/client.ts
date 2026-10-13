import { Kysely, PostgresDialect } from 'kysely';
import { Pool, types } from 'pg';
import type { Database } from './types.js';

export function createDatabase(
  connectionString: string,
  options: { max?: number; onError?: (error: Error) => void } = {},
): Kysely<Database> {
  const pool = new Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: 5_000,
    // Financial numbers and cursors must never pass through Number.
    types: {
      getTypeParser(oid, format) {
        if (format !== 'binary' && (oid === 20 || oid === 1700)) {
          return (value: string) => value;
        }
        return types.getTypeParser(oid, format);
      },
    },
  });
  // Idle connection errors otherwise become unhandled EventEmitter errors.
  // The exchange supplies a callback that marks its writer unavailable.
  pool.on('error', (error) => options.onError?.(error));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}
