import { formatQuantity, formatQuote } from '@sandbox/domain';
import type { CommandOutcome } from '../lib/api.js';
import { units } from './amounts.js';

export interface PreviewClock {
  startedAt: number;
  wallStartedAt: number;
  duration: number;
}

/** Start at request dispatch, so transport time can only shorten the review window. */
export function previewClock(
  createdAt: string,
  expiresAt: string,
  startedAt: number,
  wallStartedAt: number,
): PreviewClock {
  const duration = Date.parse(expiresAt) - Date.parse(createdAt);
  return {
    startedAt,
    wallStartedAt,
    duration: Number.isFinite(duration) ? Math.max(0, Math.min(10_000, duration)) : 0,
  };
}

export function previewRemaining(clock: PreviewClock, now: number, wallNow: number): number {
  // Wall elapsed also expires a review after sleep on platforms whose performance clock pauses.
  // A clock correction can expire early, but cannot extend the monotonic deadline.
  return Math.max(
    0,
    clock.duration - Math.max(0, now - clock.startedAt, wallNow - clock.wallStartedAt),
  );
}

export interface MarketOrderOutcome {
  orderId: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  filled: string;
  remaining: string;
  guardPrice: string;
  averagePrice: string | null;
  fee: string;
  notional: string;
  net: string;
  cancelReason: string | null;
}

/** A market order is terminal in its first receipt, including receipts recovered after reload. */
export function marketOrderOutcome(result: CommandOutcome): MarketOrderOutcome | null {
  const order = result.order;
  if (
    result.status !== 'ACCEPTED' ||
    order?.type !== 'MARKET' ||
    !order.quantity ||
    !order.remaining ||
    !order.price ||
    !order.side ||
    !result.fills
  )
    return null;
  let quote = 0n;
  let fee = 0n;
  for (const fill of result.fills) {
    const charge = order.side === 'BUY' ? fill.buyerFee : fill.sellerFee;
    if (typeof fill.notional !== 'string' || typeof charge !== 'string') return null;
    quote += units(fill.notional, 9);
    fee += units(charge, 9);
  }
  const filled = units(order.quantity, 4) - units(order.remaining, 4);
  return {
    orderId: order.id,
    side: order.side,
    quantity: order.quantity,
    filled: formatQuantity(filled),
    remaining: order.remaining,
    guardPrice: order.price,
    averagePrice: filled === 0n ? null : formatQuote((quote * 10_000n + filled / 2n) / filled),
    fee: formatQuote(fee),
    notional: formatQuote(quote),
    net: formatQuote(order.side === 'BUY' ? quote + fee : quote - fee),
    cancelReason: order.cancelReason ?? null,
  };
}
