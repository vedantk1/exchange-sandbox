import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { DomainError, matchOrder, type BookOrder, type Side } from '../src/index.js';

function order(id: string, overrides: Partial<BookOrder> = {}): BookOrder {
  return {
    id,
    accountId: `account-${id}`,
    side: 'SELL',
    price: 5_000_000n,
    quantity: 1_000n,
    remaining: 1_000n,
    sequence: BigInt(id),
    ...overrides,
  };
}

describe('price-time matching', () => {
  it('buys at the best ask and then acceptance sequence, using each maker price', () => {
    const result = matchOrder(order('10', { side: 'BUY', quantity: 2_500n, remaining: 2_500n }), [
      order('3'),
      order('2'),
      order('1', { price: 4_900_000n }),
      order('4', { price: 5_000_001n }),
    ]);
    expect(result.fills.map((fill) => [fill.makerOrderId, fill.quantity, fill.price])).toEqual([
      ['1', 1_000n, 4_900_000n],
      ['2', 1_000n, 5_000_000n],
      ['3', 500n, 5_000_000n],
    ]);
    expect(result.incoming.status).toBe('FILLED');
    expect(result.incoming.remaining).toBe(0n);
    expect(result.makers.map((maker) => maker.status)).toEqual([
      'FILLED',
      'FILLED',
      'PARTIALLY_FILLED',
    ]);
    expect(result.makers[2]?.remaining).toBe(500n);
  });

  it('sells at the best bid first and stops at the price limit', () => {
    const result = matchOrder(order('10', { quantity: 3_000n, remaining: 3_000n }), [
      order('1', { side: 'BUY', price: 4_999_999n }),
      order('2', { side: 'BUY', price: 5_100_000n }),
      order('3', { side: 'BUY', price: 5_200_000n }),
    ]);
    expect(result.fills.map((fill) => fill.makerOrderId)).toEqual(['3', '2']);
    expect(result.incoming.status).toBe('PARTIALLY_FILLED');
    expect(result.incoming.remaining).toBe(1_000n);
    expect(result.incoming.cancelReason).toBeNull();
  });

  it('keeps an unmatched order open and ignores same-side orders', () => {
    const incoming = order('10', { side: 'BUY' });
    const result = matchOrder(incoming, [
      order('1', { side: 'BUY' }),
      order('2', { price: 5_000_001n }),
    ]);
    expect(result.incoming).toEqual({ ...incoming, status: 'OPEN', cancelReason: null });
    expect(result.fills).toEqual([]);
    expect(result.makers).toEqual([]);
  });

  it('preserves prior maker fills and can execute below the submission minimum', () => {
    const maker = order('1', { quantity: 10n, remaining: 1n, price: 1n });
    const result = matchOrder(
      order('10', { side: 'BUY', quantity: 2n, remaining: 2n, price: 1n }),
      [maker],
    );
    expect(result.fills[0]?.quantity).toBe(1n);
    expect(result.makers[0]).toMatchObject({ quantity: 10n, remaining: 0n, status: 'FILLED' });
    expect(result.incoming.status).toBe('PARTIALLY_FILLED');
  });

  it('cancels incoming remainder at an own maker, preserving earlier fills and the resting order', () => {
    const own = order('2', { accountId: 'account-10' });
    const result = matchOrder(order('10', { side: 'BUY', quantity: 3_000n, remaining: 3_000n }), [
      order('3'),
      own,
      order('1'),
    ]);
    expect(result.incoming).toMatchObject({
      status: 'CANCELED',
      remaining: 2_000n,
      cancelReason: 'SELF_TRADE_PREVENTION',
    });
    expect(result.fills.map((fill) => fill.makerOrderId)).toEqual(['1']);
    expect(result.makers.map((maker) => maker.id)).toEqual(['1']);
    expect(own.remaining).toBe(1_000n);
  });

  it('cancels zero-fill self-trade attempts but does not cancel at an uncrossed own order', () => {
    const incoming = order('10', { side: 'BUY' });
    const own = order('1', { accountId: incoming.accountId });
    expect(matchOrder(incoming, [own]).incoming.status).toBe('CANCELED');
    expect(matchOrder(incoming, [{ ...own, price: incoming.price + 1n }]).incoming.status).toBe(
      'OPEN',
    );
  });

  it('does not mutate frozen inputs', () => {
    const incoming = Object.freeze(order('10', { side: 'BUY' }));
    const maker = Object.freeze(order('1'));
    const result = matchOrder(incoming, Object.freeze([maker]));
    expect(result.incoming.remaining).toBe(0n);
    expect(incoming.remaining).toBe(1_000n);
    expect(maker.remaining).toBe(1_000n);
  });

  it('rejects corrupt book inputs rather than double-filling them', () => {
    const incoming = order('10', { side: 'BUY' });
    expect(() => matchOrder(incoming, [order('1'), order('1')])).toThrow(DomainError);
    expect(() => matchOrder(incoming, [order('1', { remaining: 0n })])).toThrow(DomainError);
    expect(() => matchOrder(incoming, [order('1', { remaining: 1_001n })])).toThrow(DomainError);
    expect(() => matchOrder(incoming, [order('1', { sequence: incoming.sequence })])).toThrow(
      DomainError,
    );
  });

  it('conserves quantities, respects limits, and leaves no executable other-account maker while incoming remains', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<Side>('BUY', 'SELL'),
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.array(
          fc.record({
            price: fc.integer({ min: 1, max: 10_000 }),
            quantity: fc.integer({ min: 1, max: 10_000 }),
          }),
          { maxLength: 40 },
        ),
        (side, price, quantity, levels) => {
          const incoming = order('100', {
            side,
            price: BigInt(price),
            quantity: BigInt(quantity),
            remaining: BigInt(quantity),
          });
          const book = levels.map((level, i) =>
            order(String(i + 1), {
              side: side === 'BUY' ? 'SELL' : 'BUY',
              price: BigInt(level.price),
              quantity: BigInt(level.quantity),
              remaining: BigInt(level.quantity),
            }),
          );
          const result = matchOrder(incoming, [...book].reverse());
          const filled = result.fills.reduce((sum, fill) => sum + fill.quantity, 0n);
          expect(result.incoming.remaining + filled).toBe(incoming.remaining);

          for (const fill of result.fills) {
            expect(fill.quantity).toBeGreaterThan(0n);
            expect(fill.makerAccountId).not.toBe(fill.takerAccountId);
            expect(
              side === 'BUY' ? fill.price <= incoming.price : fill.price >= incoming.price,
            ).toBe(true);
            const before = book.find((maker) => maker.id === fill.makerOrderId)!;
            const after = result.makers.find((maker) => maker.id === fill.makerOrderId)!;
            expect(after.remaining).toBeGreaterThanOrEqual(0n);
            expect(after.remaining + fill.quantity).toBe(before.remaining);
          }

          if (result.incoming.remaining > 0n) {
            for (const before of book) {
              const after = result.makers.find((maker) => maker.id === before.id) ?? before;
              const crosses =
                side === 'BUY' ? after.price <= incoming.price : after.price >= incoming.price;
              expect(crosses && after.remaining > 0n).toBe(false);
            }
          }

          // Input ordering must not influence exchange priority.
          expect(matchOrder(incoming, book)).toEqual(result);
        },
      ),
    );
  });
});
