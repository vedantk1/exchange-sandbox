import { MAX_ORDER_QUANTITY, MAX_PRICE } from './amounts.js';
import { DomainError } from './errors.js';

export type Side = 'BUY' | 'SELL';
export type OrderStatus = 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';

export interface BookOrder {
  id: string;
  accountId: string;
  side: Side;
  price: bigint;
  quantity: bigint;
  remaining: bigint;
  sequence: bigint;
}

export interface Fill {
  makerOrderId: string;
  takerOrderId: string;
  makerAccountId: string;
  takerAccountId: string;
  quantity: bigint;
  price: bigint;
}

export interface MatchResult {
  incoming: BookOrder & { status: OrderStatus; cancelReason: string | null };
  /** Only changed makers, in execution order. Untouched orders are not returned. */
  makers: Array<BookOrder & { status: OrderStatus }>;
  fills: Fill[];
}

function assertBookOrder(order: BookOrder): void {
  if (
    typeof order.id !== 'string' ||
    order.id.length === 0 ||
    typeof order.accountId !== 'string' ||
    order.accountId.length === 0 ||
    (order.side !== 'BUY' && order.side !== 'SELL') ||
    typeof order.price !== 'bigint' ||
    order.price < 1n ||
    order.price > MAX_PRICE ||
    typeof order.quantity !== 'bigint' ||
    order.quantity < 1n ||
    order.quantity > MAX_ORDER_QUANTITY ||
    typeof order.remaining !== 'bigint' ||
    order.remaining < 1n ||
    order.remaining > order.quantity ||
    typeof order.sequence !== 'bigint' ||
    order.sequence < 1n
  ) {
    throw new DomainError(
      'INVALID_BOOK',
      'Matching requires valid active orders in integer units.',
    );
  }
}

function status(order: BookOrder): Exclude<OrderStatus, 'CANCELED'> {
  if (order.remaining === 0n) return 'FILLED';
  return order.remaining < order.quantity ? 'PARTIALLY_FILLED' : 'OPEN';
}

function compareInteger(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Pure price/time matching. The caller supplies an authoritative book snapshot
 * and commits fills, accounting, and order changes together. No input is mutated.
 * Admission checks (funds, session, minimum notional) belong before this function.
 */
export function matchOrder(incoming: BookOrder, resting: readonly BookOrder[]): MatchResult {
  assertBookOrder(incoming);
  const ids = new Set([incoming.id]);
  const sequences = new Set([incoming.sequence]);
  for (const order of resting) {
    assertBookOrder(order);
    if (ids.has(order.id) || sequences.has(order.sequence)) {
      throw new DomainError(
        'INVALID_BOOK',
        'Order identities and acceptance sequences must be unique.',
      );
    }
    ids.add(order.id);
    sequences.add(order.sequence);
  }

  const book = resting
    .filter((order) => order.side !== incoming.side)
    .sort((a, b) => {
      const byPrice =
        incoming.side === 'BUY'
          ? compareInteger(a.price, b.price)
          : compareInteger(b.price, a.price);
      return byPrice || compareInteger(a.sequence, b.sequence);
    });

  const result: MatchResult = {
    incoming: { ...incoming, status: status(incoming), cancelReason: null },
    makers: [],
    fills: [],
  };

  for (const restingOrder of book) {
    if (result.incoming.remaining === 0n) break;
    const crosses =
      incoming.side === 'BUY'
        ? restingOrder.price <= incoming.price
        : restingOrder.price >= incoming.price;
    if (!crosses) break;

    if (restingOrder.accountId === incoming.accountId) {
      result.incoming.status = 'CANCELED';
      result.incoming.cancelReason = 'SELF_TRADE_PREVENTION';
      return result;
    }

    const quantity =
      result.incoming.remaining < restingOrder.remaining
        ? result.incoming.remaining
        : restingOrder.remaining;
    const maker = { ...restingOrder, remaining: restingOrder.remaining - quantity };
    result.incoming.remaining -= quantity;
    result.makers.push({ ...maker, status: status(maker) });
    result.fills.push({
      makerOrderId: maker.id,
      takerOrderId: incoming.id,
      makerAccountId: maker.accountId,
      takerAccountId: incoming.accountId,
      quantity,
      price: maker.price,
    });
  }

  result.incoming.status = status(result.incoming);
  return result;
}
