import { MAX_PRICE, fee, formatQuote, notional } from './amounts.js';
import { DomainError } from './errors.js';
import { matchOrder, type BookOrder, type MatchResult, type Side } from './matching.js';

/** Round inward to the price tick: the fixed guard never permits more than 5%. */
export function marketPriceGuard(side: Side, referencePrice: bigint): bigint {
  if (
    (side !== 'BUY' && side !== 'SELL') ||
    typeof referencePrice !== 'bigint' ||
    referencePrice < 1n ||
    referencePrice > MAX_PRICE
  ) {
    throw new DomainError('INVALID_PRICE', 'A valid side and reference price are required.');
  }
  const guard =
    side === 'BUY' ? (referencePrice * 105n) / 100n : (referencePrice * 95n + 99n) / 100n;
  if (guard > MAX_PRICE) {
    throw new DomainError(
      'PRICE_GUARD_OUT_OF_RANGE',
      'The protected price exceeds the supported price range.',
    );
  }
  return guard;
}

/** Market orders share price/time matching and cancel-newer self-trade prevention. */
export function matchMarketOrder(incoming: BookOrder, resting: readonly BookOrder[]): MatchResult {
  const result = matchOrder(incoming, resting);
  if (result.incoming.remaining === 0n || result.incoming.status === 'CANCELED') return result;

  const opposing = resting.filter((order) => order.side !== incoming.side);
  const beyondGuard = opposing.some((order) =>
    incoming.side === 'BUY' ? order.price > incoming.price : order.price < incoming.price,
  );
  result.incoming.status = 'CANCELED';
  result.incoming.cancelReason =
    opposing.length === 0
      ? 'NO_LIQUIDITY'
      : beyondGuard
        ? 'PRICE_GUARD_REACHED'
        : 'INSUFFICIENT_LIQUIDITY';
  return result;
}

/** Totals stay exact; the indicative average alone is rounded half-up to nine decimals. */
export function summarizeMarketMatch(match: MatchResult): {
  filledQuantity: bigint;
  remainingQuantity: bigint;
  notional: bigint;
  fee: bigint;
  averagePrice: string | null;
  cancelReason: string | null;
} {
  let filledQuantity = 0n;
  let value = 0n;
  let charge = 0n;
  let priceProduct = 0n;
  for (const fill of match.fills) {
    filledQuantity += fill.quantity;
    value += notional(fill.quantity, fill.price);
    charge += fee(fill.quantity, fill.price);
    priceProduct += fill.quantity * fill.price;
  }
  return {
    filledQuantity,
    remainingQuantity: match.incoming.remaining,
    notional: value,
    fee: charge,
    averagePrice:
      filledQuantity === 0n
        ? null
        : formatQuote((priceProduct * 20_000_000n + filledQuantity) / (filledQuantity * 2n)),
    cancelReason: match.incoming.cancelReason,
  };
}
