import { formatPrice, formatQuantity } from '@sandbox/domain';
import { sql } from 'kysely';
import type { Exchange } from './exchange.js';
import { requirePrincipal } from './auth/access.js';
import { AuthError } from './auth/errors.js';
import { detailedOrders, ownerFill } from './workspace.js';

export async function marketSnapshot(exchange: Exchange, token: string) {
  return exchange.readTransaction(async (tx) => {
    await requirePrincipal(tx, token);
    const control = await tx
      .selectFrom('exchange_control')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    if (!control.active_session_id)
      throw new AuthError('NOT_BOOTSTRAPPED', 'Complete local administrator setup first.', 503);
    const sessionId = control.active_session_id;
    const side = async (side: 'BUY' | 'SELL') => {
      const rows = await tx
        .selectFrom('orders')
        .select(['price', sql<string>`sum(remaining_quantity)`.as('quantity')])
        .where('session_id', '=', sessionId)
        .where('side', '=', side)
        .where('status', 'in', ['OPEN', 'PARTIALLY_FILLED'])
        .groupBy('price')
        .orderBy('price', side === 'BUY' ? 'desc' : 'asc')
        .limit(50)
        .execute();
      return rows.map((row) => ({
        price: formatPrice(BigInt(row.price)),
        quantity: formatQuantity(BigInt(row.quantity)),
      }));
    };
    const bids = await side('BUY');
    const asks = await side('SELL');
    const fills = await tx
      .selectFrom('fills')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('sequence', 'desc')
      .orderBy('fill_index', 'desc')
      .limit(100)
      .execute();
    return {
      sessionId,
      marketState: control.market_state,
      fault: exchange.getRuntimeFault() || control.fault ? 'ACCOUNTING_FAULT' : null,
      book: { bids, asks },
      trades: fills.map((fill) => ({
        price: formatPrice(BigInt(fill.price)),
        quantity: formatQuantity(BigInt(fill.quantity)),
        sequence: fill.sequence,
        fillIndex: fill.fill_index,
        timestamp: fill.created_at.toISOString(),
      })),
    };
  });
}

export async function privateOrder(exchange: Exchange, token: string, orderId: string) {
  return exchange.readTransaction(async (tx) => {
    const actor = await requirePrincipal(tx, token);
    let orderQuery = tx.selectFrom('orders').selectAll().where('id', '=', orderId);
    if (actor.role === 'TRADER') orderQuery = orderQuery.where('account_id', '=', actor.accountId);
    const order = await orderQuery.executeTakeFirst();
    if (!order) throw new AuthError('ORDER_NOT_FOUND', 'Order not found.', 404);
    const fills = await tx
      .selectFrom('fills')
      .selectAll()
      .where((eb) => eb.or([eb('buy_order_id', '=', order.id), eb('sell_order_id', '=', order.id)]))
      .orderBy('sequence')
      .orderBy('fill_index')
      .limit(100)
      .execute();
    return {
      sessionId: order.session_id,
      order: (await detailedOrders(tx, [order]))[0]!,
      fills: fills.map((fill) => ownerFill(fill, order)),
      historyLimit: 100,
    };
  });
}
