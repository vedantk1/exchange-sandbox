import { randomUUID } from 'node:crypto';
import type { Asset, Bucket, Database } from '@sandbox/database';
import { sql, type Transaction } from 'kysely';
import { RecoveryError } from './errors.js';

export interface Posting {
  accountId: string;
  asset: Asset;
  bucket: Bucket;
  amount: bigint;
}

export function transferHold(accountId: string, asset: Asset, amount: bigint): Posting[] {
  return [
    { accountId, asset, bucket: 'AVAILABLE', amount: -amount },
    { accountId, asset, bucket: 'RESERVED', amount },
  ];
}

/** The journal and its balance projection always change in the caller's transaction. */
export async function postJournal(
  tx: Transaction<Database>,
  sessionId: string,
  commandId: string,
  kind: string,
  postings: Posting[],
): Promise<void> {
  const nonzero = postings.filter((posting) => posting.amount !== 0n);
  if (nonzero.length === 0) return;
  for (const asset of ['BTC-SIM', 'USD-SIM'] as const) {
    if (nonzero.filter((p) => p.asset === asset).reduce((sum, p) => sum + p.amount, 0n) !== 0n) {
      throw new RecoveryError(`Unbalanced ${asset} journal proposal.`);
    }
  }
  const id = randomUUID();
  await tx
    .insertInto('journal_transactions')
    .values({
      id,
      session_id: sessionId,
      command_id: commandId,
      kind,
    })
    .execute();
  await tx
    .insertInto('journal_entries')
    .values(
      nonzero.map((posting) => ({
        journal_transaction_id: id,
        session_id: sessionId,
        account_id: posting.accountId,
        asset: posting.asset,
        bucket: posting.bucket,
        amount: posting.amount.toString(),
      })),
    )
    .execute();

  // Aggregate each projection delta; intermediate posting order cannot cause a
  // false overdraft. PostgreSQL checks final balances again at commit.
  const deltas = new Map<string, Posting>();
  for (const posting of nonzero) {
    const key = `${posting.accountId}/${posting.asset}/${posting.bucket}`;
    const prior = deltas.get(key);
    deltas.set(key, { ...posting, amount: (prior?.amount ?? 0n) + posting.amount });
  }
  for (const posting of deltas.values()) {
    if (posting.amount === 0n) continue;
    await tx
      .insertInto('balances')
      .values({
        session_id: sessionId,
        account_id: posting.accountId,
        asset: posting.asset,
        bucket: posting.bucket,
        amount: posting.amount.toString(),
      })
      .onConflict((conflict) =>
        conflict.columns(['session_id', 'account_id', 'asset', 'bucket']).doUpdateSet({
          amount: sql<string>`balances.amount + ${posting.amount.toString()}::numeric`,
        }),
      )
      .execute();
  }
}
