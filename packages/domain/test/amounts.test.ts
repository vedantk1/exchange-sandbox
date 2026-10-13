import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  assertOrderSubmission,
  buyReservation,
  DomainError,
  fee,
  formatPrice,
  formatQuantity,
  formatQuote,
  MAX_ORDER_QUANTITY,
  MAX_PRICE,
  MAX_QUOTE,
  notional,
  parsePrice,
  parseQuantity,
  parseQuote,
} from '../src/index.js';

describe('exact decimal boundaries', () => {
  it('parses and formats every asset in its declared units', () => {
    expect(parseQuantity('1')).toBe(10_000n);
    expect(parseQuantity('0.0001')).toBe(1n);
    expect(parsePrice('50000')).toBe(5_000_000n);
    expect(parseQuote('0.000000001')).toBe(1n);
    expect(formatQuantity(15n)).toBe('0.0015');
    expect(formatPrice(5_000_001n)).toBe('50000.01');
    expect(formatQuote(1n)).toBe('0.000000001');
    expect(formatQuote(-1_000_000_001n)).toBe('-1.000000001');
    expect(formatQuantity(0n)).toBe('0.0000');
  });

  it.each([
    '',
    ' 1',
    '1 ',
    '1\n',
    '1\r\n',
    '+1',
    '-1',
    '1e2',
    '01',
    '.1',
    '1.',
    'NaN',
    'Infinity',
    '0.00010',
  ])('rejects unsupported quantity input %j rather than rounding/coercing', (input) =>
    expect(() => parseQuantity(input)).toThrow(DomainError),
  );

  it('rejects JSON numbers, excess precision, zero orders, and out-of-range inputs', () => {
    expect(() => parseQuantity(1 as unknown as string)).toThrow(DomainError);
    expect(() => parseQuantity('0')).toThrow(DomainError);
    expect(() => parsePrice('0')).toThrow(DomainError);
    expect(() => parsePrice('1.001')).toThrow(DomainError);
    expect(() => parseQuote('1.0000000000')).toThrow(DomainError);
    expect(() => parseQuantity('100.0001')).toThrow(DomainError);
    expect(() => parsePrice('100000000.01')).toThrow(DomainError);
    expect(() => parseQuote('100000000000000000000000000000')).toThrow(DomainError);
    expect(() => parseQuote('9'.repeat(1_000))).toThrow(DomainError);
  });

  it('accepts the exact engineering bounds and a zero quote value', () => {
    expect(parseQuantity('100')).toBe(MAX_ORDER_QUANTITY);
    expect(parsePrice('100000000')).toBe(MAX_PRICE);
    expect(parseQuote('99999999999999999999999999999.999999999')).toBe(MAX_QUOTE);
    expect(parseQuote('0')).toBe(0n);
  });

  it('round-trips all representable valid order values without floating point', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: MAX_ORDER_QUANTITY }),
        fc.bigInt({ min: 1n, max: MAX_PRICE }),
        fc.bigInt({ min: 0n, max: MAX_QUOTE }),
        (quantity, price, quote) => {
          expect(parseQuantity(formatQuantity(quantity))).toBe(quantity);
          expect(parsePrice(formatPrice(price))).toBe(price);
          expect(parseQuote(formatQuote(quote))).toBe(quote);
        },
      ),
    );
  });
});

describe('fees and reservations', () => {
  it('calculates a price-improved partial fill exactly', () => {
    const requested = parseQuantity('0.5');
    const executed = parseQuantity('0.2');
    const cap = parsePrice('50000');
    const executionPrice = parsePrice('49000');

    expect(formatQuote(buyReservation(requested, cap))).toBe('25025.000000000');
    expect(formatQuote(notional(executed, executionPrice))).toBe('9800.000000000');
    expect(formatQuote(fee(executed, executionPrice))).toBe('9.800000000');
    const remaining = requested - executed;
    expect(formatQuote(buyReservation(remaining, cap))).toBe('15015.000000000');
    const release =
      buyReservation(requested, cap) -
      notional(executed, executionPrice) -
      fee(executed, executionPrice) -
      buyReservation(remaining, cap);
    expect(formatQuote(release)).toBe('200.200000000');
    expect(buyReservation(0n, cap)).toBe(0n);
  });

  it('enforces minimum notional on submission, not on valid tiny fills', () => {
    expect(() =>
      assertOrderSubmission(parseQuantity('0.0001'), parsePrice('9999.99')),
    ).toThrowError(expect.objectContaining({ code: 'ORDER_TOO_SMALL' }));
    expect(() => assertOrderSubmission(parseQuantity('0.0001'), parsePrice('10000'))).not.toThrow();
    expect(notional(1n, 1n)).toBe(1_000n);
    expect(fee(1n, 1n)).toBe(1n);
  });

  it('rejects invalid integer inputs before arithmetic', () => {
    expect(() => notional(-1n, 1n)).toThrow(DomainError);
    expect(() => fee(1n, 0n)).toThrow(DomainError);
    expect(() => buyReservation(MAX_ORDER_QUANTITY + 1n, 1n)).toThrow(DomainError);
    expect(() => notional(1 as unknown as bigint, 1n)).toThrow(DomainError);
  });

  it('splitting fills never changes their total notional or fees', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: MAX_ORDER_QUANTITY }),
        fc.bigInt({ min: 1n, max: MAX_PRICE }),
        fc.integer({ min: 0, max: 100 }),
        (quantity, price, fraction) => {
          const first = (quantity * BigInt(fraction)) / 100n;
          const second = quantity - first;
          expect(fee(first, price) + fee(second, price)).toBe(fee(quantity, price));
          expect(notional(first, price) + notional(second, price)).toBe(notional(quantity, price));
        },
      ),
    );
  });

  it('each price-improved buy can settle and release surplus without a deficit', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: MAX_ORDER_QUANTITY }),
        fc.bigInt({ min: 1n, max: MAX_PRICE }),
        fc.integer({ min: 0, max: 100 }),
        fc.integer({ min: 0, max: 100 }),
        (quantity, priceCap, fillPercent, improvementPercent) => {
          const filled = (quantity * BigInt(fillPercent)) / 100n;
          const executionPrice = 1n + ((priceCap - 1n) * BigInt(improvementPercent)) / 100n;
          const before = buyReservation(quantity, priceCap);
          const cost = notional(filled, executionPrice) + fee(filled, executionPrice);
          const retained = buyReservation(quantity - filled, priceCap);
          const released = before - cost - retained;
          expect(released).toBeGreaterThanOrEqual(0n);
          expect(cost + retained + released).toBe(before);
          expect(released).toBe(
            buyReservation(filled, priceCap) - buyReservation(filled, executionPrice),
          );
        },
      ),
    );
  });
});
