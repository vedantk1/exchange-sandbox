import type { Database } from '@sandbox/database';
import { sql, type Transaction } from 'kysely';

/** One PostgreSQL clock value for all evidence belonging to an admitted transaction. */
export const commandTimestamp = sql<Date>`exchange_command_timestamp()`;

/** Called after admission, never at transaction start or while waiting for the writer. */
export async function captureCommandTimestamp(tx: Transaction<Database>): Promise<void> {
  await sql`
    SELECT set_config('sandbox.command_timestamp', clock_timestamp()::text, true)
  `.execute(tx);
}
