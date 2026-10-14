import { randomUUID } from 'node:crypto';
import { commandTimestamp } from './command-time.js';
import type { Database } from '@sandbox/database';
import type { Transaction } from 'kysely';
import { postJournal, transferHold } from './ledger.js';
import { orderView } from './views.js';

/** Internal helpers: callers hold the installation lock and establish authorization. */
export async function initializeSession(
  tx: Transaction<Database>,
  options: { marketState: 'PAUSED' | 'TRADING' },
) {
  const control = await tx
    .selectFrom('exchange_control')
    .selectAll()
    .where('id', '=', 1)
    .executeTakeFirstOrThrow();
  let sessionId = control.active_session_id;
  if (!sessionId) {
    sessionId = randomUUID();
    await tx.insertInto('exchange_sessions').values({ id: sessionId, state: 'ACTIVE' }).execute();
    await tx
      .updateTable('exchange_control')
      .set({ active_session_id: sessionId, market_state: options.marketState })
      .where('id', '=', 1)
      .execute();
  }
  const systemAccount = async (kind: 'FEE' | 'ISSUANCE') => {
    const existing = await tx
      .selectFrom('accounts')
      .select('id')
      .where('kind', '=', kind)
      .executeTakeFirst();
    if (existing) return existing.id;
    const id = randomUUID();
    await tx.insertInto('accounts').values({ id, kind, label: kind.toLowerCase() }).execute();
    return id;
  };
  return {
    sessionId,
    feeAccountId: await systemAccount('FEE'),
    issuanceAccountId: await systemAccount('ISSUANCE'),
  };
}

export async function allocateTrader(
  tx: Transaction<Database>,
  sessionId: string,
  accountId: string,
  commandId: string,
): Promise<void> {
  const allocation = await tx
    .selectFrom('allocations')
    .select('account_id')
    .where('account_id', '=', accountId)
    .where('session_id', '=', sessionId)
    .executeTakeFirst();
  if (allocation) return;
  const issuance = await tx
    .selectFrom('accounts')
    .select('id')
    .where('kind', '=', 'ISSUANCE')
    .executeTakeFirstOrThrow();
  await postJournal(tx, sessionId, commandId, 'ALLOCATE', [
    { accountId, asset: 'BTC-SIM', bucket: 'AVAILABLE', amount: 10_000n },
    { accountId: issuance.id, asset: 'BTC-SIM', bucket: 'AVAILABLE', amount: -10_000n },
    { accountId, asset: 'USD-SIM', bucket: 'AVAILABLE', amount: 100_000_000_000_000n },
    {
      accountId: issuance.id,
      asset: 'USD-SIM',
      bucket: 'AVAILABLE',
      amount: -100_000_000_000_000n,
    },
  ]);
  await tx
    .insertInto('allocations')
    .values({ session_id: sessionId, account_id: accountId, command_id: commandId })
    .execute();
}

export async function cancelOrder(
  tx: Transaction<Database>,
  input: { sessionId: string; orderId: string; commandId: string; reason: string },
) {
  const order = await tx
    .selectFrom('orders')
    .selectAll()
    .where('id', '=', input.orderId)
    .where('session_id', '=', input.sessionId)
    .executeTakeFirst();
  if (!order) return null;
  if (order.status === 'FILLED' || order.status === 'CANCELED') return orderView(order);
  await postJournal(
    tx,
    input.sessionId,
    input.commandId,
    'CANCEL',
    transferHold(
      order.account_id,
      order.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM',
      -BigInt(order.reserved_amount),
    ),
  );
  const updated = await tx
    .updateTable('orders')
    .set({
      status: 'CANCELED',
      reserved_amount: '0',
      cancel_reason: input.reason,
      updated_at: commandTimestamp,
    })
    .where('id', '=', order.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  return orderView(updated);
}
