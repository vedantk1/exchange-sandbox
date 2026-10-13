import type { Database } from '@sandbox/database';
import { formatPrice, formatQuantity, formatQuote, type BookOrder } from '@sandbox/domain';
import type { Selectable } from 'kysely';
import type { FillView, OrderView } from './types.js';

export function bookOrder(order: Selectable<Database['orders']>): BookOrder {
  return {
    id: order.id,
    accountId: order.account_id,
    side: order.side,
    price: BigInt(order.price),
    quantity: BigInt(order.quantity),
    remaining: BigInt(order.remaining_quantity),
    sequence: BigInt(order.acceptance_sequence),
  };
}

export function orderView(order: Selectable<Database['orders']>): OrderView {
  return {
    id: order.id,
    accountId: order.account_id,
    side: order.side,
    price: formatPrice(BigInt(order.price)),
    type: order.type,
    quantity: formatQuantity(BigInt(order.quantity)),
    remaining: formatQuantity(BigInt(order.remaining_quantity)),
    status: order.status,
    cancelReason: order.cancel_reason,
    reserved: (order.side === 'BUY' ? formatQuote : formatQuantity)(BigInt(order.reserved_amount)),
    sequence: order.acceptance_sequence,
  };
}

export function fillView(fill: Selectable<Database['fills']>): FillView {
  return {
    id: fill.id,
    makerOrderId: fill.maker_order_id,
    takerOrderId: fill.taker_order_id,
    buyOrderId: fill.buy_order_id,
    sellOrderId: fill.sell_order_id,
    quantity: formatQuantity(BigInt(fill.quantity)),
    price: formatPrice(BigInt(fill.price)),
    notional: formatQuote(BigInt(fill.notional)),
    buyerFee: formatQuote(BigInt(fill.buyer_fee)),
    sellerFee: formatQuote(BigInt(fill.seller_fee)),
    sequence: fill.sequence,
    fillIndex: fill.fill_index,
  };
}
