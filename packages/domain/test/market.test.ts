import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MAX_PRICE,
  marketPriceGuard,
  matchMarketOrder,
  summarizeMarketMatch,
  type BookOrder,
  type Side,
} from '../src/index.js';

function order(id: string, overrides: Partial<BookOrder> = {}): BookOrder {
  return {
    id,
    accountId: `account-${id}`,
    side: 'SELL',
    price: 100n,
    quantity: 1_000n,
    remaining: 1_000n,
    sequence: BigInt(id),
    ...overrides,
  };
}

describe('protected immediate orders', () => {
  it('rounds protection inward on both sides and rejects an unsupported buy guard', () => {
    expect(marketPriceGuard('BUY', 101n)).toBe(106n);
    expect(marketPriceGuard('SELL', 101n)).toBe(96n);
    expect(marketPriceGuard('BUY', 1n)).toBe(1n);
    expect(marketPriceGuard('SELL', 1n)).toBe(1n);
    expect(() => marketPriceGuard('BUY', MAX_PRICE)).toThrow(
      'The protected price exceeds the supported price range.',
    );
  });

  it('never widens 5% protection through tick rounding', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: (MAX_PRICE * 100n) / 105n }), (reference) => {
        const buy = marketPriceGuard('BUY', reference);
        const sell = marketPriceGuard('SELL', reference);
        expect(buy).toBeGreaterThanOrEqual(reference);
        expect(buy * 100n).toBeLessThanOrEqual(reference * 105n);
        expect((buy + 1n) * 100n).toBeGreaterThan(reference * 105n);
        expect(sell).toBeLessThanOrEqual(reference);
        expect(sell * 100n).toBeGreaterThanOrEqual(reference * 95n);
        expect((sell - 1n) * 100n).toBeLessThan(reference * 95n);
      }),
    );
  });

  it('fills at the guard inclusively, then cancels with the protection reason', () => {
    const incoming = order('100', {
      side: 'BUY',
      price: 105n,
      quantity: 2_000n,
      remaining: 2_000n,
    });
    const result = matchMarketOrder(incoming, [
      order('1', { price: 105n }),
      order('2', { price: 106n }),
    ]);
    expect(result.incoming).toMatchObject({
      status: 'CANCELED',
      remaining: 1_000n,
      cancelReason: 'PRICE_GUARD_REACHED',
    });
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0]?.price).toBe(105n);
    expect(result.makers.map((maker) => maker.id)).toEqual(['1']);
  });

  it('distinguishes an empty book, exhausted liquidity, and self-trade prevention', () => {
    const incoming = order('100', { side: 'BUY', quantity: 2_000n, remaining: 2_000n });
    expect(matchMarketOrder(incoming, []).incoming.cancelReason).toBe('NO_LIQUIDITY');
    expect(matchMarketOrder(incoming, [order('1')]).incoming.cancelReason).toBe(
      'INSUFFICIENT_LIQUIDITY',
    );
    const own = order('2', { accountId: incoming.accountId });
    const result = matchMarketOrder(incoming, [own, order('1'), order('3')]);
    expect(result.incoming).toMatchObject({
      status: 'CANCELED',
      remaining: 1_000n,
      cancelReason: 'SELF_TRADE_PREVENTION',
    });
    expect(result.fills.map((fill) => fill.makerOrderId)).toEqual(['1']);
    expect(own.remaining).toBe(1_000n);
  });

  it('totals exact fill quantities, value, and fees with only the display average rounded', () => {
    const result = matchMarketOrder(
      order('100', { side: 'BUY', price: 105n, quantity: 3n, remaining: 3n }),
      [
        order('1', { quantity: 1n, remaining: 1n, price: 100n }),
        order('2', { quantity: 2n, remaining: 2n, price: 101n }),
      ],
    );
    expect(summarizeMarketMatch(result)).toEqual({
      filledQuantity: 3n,
      remainingQuantity: 0n,
      notional: 302_000n,
      fee: 302n,
      averagePrice: '1.006666667',
      cancelReason: null,
    });
    expect(summarizeMarketMatch(matchMarketOrder(order('100'), []))).toMatchObject({
      notional: 0n,
      fee: 0n,
      averagePrice: null,
    });
    const halfTie = matchMarketOrder(
      order('100', { side: 'BUY', price: 105n, quantity: 256n, remaining: 256n }),
      [
        order('1', { quantity: 255n, remaining: 255n, price: 100n }),
        order('2', { quantity: 1n, remaining: 1n, price: 101n }),
      ],
    );
    expect(summarizeMarketMatch(halfTie).averagePrice).toBe('1.000039063');
  });

  it('always finishes terminal, conserves quantity, and never executes beyond either guard', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>('BUY', 'SELL'),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(
          fc.record({
            price: fc.integer({ min: 1, max: 10_000 }),
            quantity: fc.integer({ min: 1, max: 10_000 }),
            own: fc.boolean(),
          }),
          { maxLength: 40 },
        ),
        (side, price, quantity, levels) => {
          const incoming = Object.freeze(
            order('100', {
              side,
              price: BigInt(price),
              quantity: BigInt(quantity),
              remaining: BigInt(quantity),
            }),
          );
          const book = Object.freeze(
            levels.map((level, index) =>
              Object.freeze(
                order(String(index + 1), {
                  accountId: level.own ? incoming.accountId : `maker-${index}`,
                  side: side === 'BUY' ? 'SELL' : 'BUY',
                  price: BigInt(level.price),
                  quantity: BigInt(level.quantity),
                  remaining: BigInt(level.quantity),
                }),
              ),
            ),
          );
          const result = matchMarketOrder(incoming, book);
          expect(['FILLED', 'CANCELED']).toContain(result.incoming.status);
          expect(
            result.incoming.remaining + result.fills.reduce((sum, fill) => sum + fill.quantity, 0n),
          ).toBe(incoming.quantity);
          expect(result.incoming.status === 'FILLED').toBe(result.incoming.remaining === 0n);
          for (const fill of result.fills) {
            expect(
              side === 'BUY' ? fill.price <= incoming.price : fill.price >= incoming.price,
            ).toBe(true);
            expect(fill.makerAccountId).not.toBe(fill.takerAccountId);
          }
          expect(matchMarketOrder(incoming, [...book].reverse())).toEqual(result);
        },
      ),
    );
  });
});
