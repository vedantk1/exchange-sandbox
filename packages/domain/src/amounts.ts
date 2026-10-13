import { DomainError } from './errors.js';

declare const quantityBrand: unique symbol;
declare const priceBrand: unique symbol;
declare const quoteBrand: unique symbol;

/** One unit is 0.0001 BTC-SIM. */
export type Quantity = bigint & { readonly [quantityBrand]: true };
/** One unit is 0.01 USD-SIM per BTC-SIM. */
export type Price = bigint & { readonly [priceBrand]: true };
/** One unit is 0.000000001 USD-SIM. */
export type Quote = bigint & { readonly [quoteBrand]: true };

export const QUANTITY_SCALE = 10_000n;
export const PRICE_SCALE = 100n;
export const QUOTE_SCALE = 1_000_000_000n;
export const MAX_ORDER_QUANTITY = 1_000_000n;
export const MAX_PRICE = 10_000_000_000n;
export const MAX_QUOTE = 10n ** 38n - 1n;
export const MIN_ORDER_NOTIONAL = QUOTE_SCALE;

function parseDecimal(value: string, decimals: number, code: string): bigint {
  // Reject coercion, whitespace, signs, exponents, and excess precision. Even
  // trailing zeroes beyond supported precision are invalid input, not rounding.
  if (typeof value !== 'string' || value.length > 64) {
    throw new DomainError(code, 'An exact decimal string is required.');
  }
  const pattern = new RegExp(`^(0|[1-9][0-9]*)(?:\\.([0-9]{1,${decimals}}))?$`);
  const match = pattern.exec(value);
  if (!match || match[0] !== value) {
    throw new DomainError(
      code,
      `Use a nonnegative decimal string with at most ${decimals} decimal places.`,
    );
  }
  return BigInt(match[1]! + (match[2] ?? '').padEnd(decimals, '0'));
}

function bounded(value: bigint, min: bigint, max: bigint, code: string): bigint {
  if (typeof value !== 'bigint' || value < min || value > max) {
    throw new DomainError(code, 'Value is outside the supported range.');
  }
  return value;
}

export function parseQuantity(value: string): Quantity {
  return bounded(
    parseDecimal(value, 4, 'INVALID_QUANTITY'),
    1n,
    MAX_ORDER_QUANTITY,
    'INVALID_QUANTITY',
  ) as Quantity;
}

export function parsePrice(value: string): Price {
  return bounded(parseDecimal(value, 2, 'INVALID_PRICE'), 1n, MAX_PRICE, 'INVALID_PRICE') as Price;
}

export function parseQuote(value: string): Quote {
  return bounded(parseDecimal(value, 9, 'INVALID_QUOTE'), 0n, MAX_QUOTE, 'INVALID_QUOTE') as Quote;
}

/** Formatting permits signed journal deltas and zero without losing precision. */
function formatDecimal(value: bigint, decimals: number): string {
  if (typeof value !== 'bigint') {
    throw new DomainError('INVALID_AMOUNT', 'Formatting requires integer units.');
  }
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(decimals + 1, '0');
  return `${sign}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

export const formatQuantity = (value: bigint): string => formatDecimal(value, 4);
export const formatPrice = (value: bigint): string => formatDecimal(value, 2);
export const formatQuote = (value: bigint): string => formatDecimal(value, 9);

function product(quantity: bigint, price: bigint): bigint {
  bounded(quantity, 0n, MAX_ORDER_QUANTITY, 'INVALID_QUANTITY');
  bounded(price, 1n, MAX_PRICE, 'INVALID_PRICE');
  return quantity * price;
}

export function notional(quantity: bigint, price: bigint): Quote {
  return bounded(product(quantity, price) * 1_000n, 0n, MAX_QUOTE, 'AMOUNT_OVERFLOW') as Quote;
}

/** Each side pays 0.1% of execution notional in quote units, exactly. */
export function fee(quantity: bigint, price: bigint): Quote {
  return bounded(product(quantity, price), 0n, MAX_QUOTE, 'AMOUNT_OVERFLOW') as Quote;
}

export function buyReservation(quantity: bigint, priceCap: bigint): Quote {
  return bounded(product(quantity, priceCap) * 1_001n, 0n, MAX_QUOTE, 'AMOUNT_OVERFLOW') as Quote;
}

/** Apply only at submission; a valid fill or remaining order may be smaller. */
export function assertOrderSubmission(quantity: bigint, price: bigint): void {
  bounded(quantity, 1n, MAX_ORDER_QUANTITY, 'INVALID_QUANTITY');
  bounded(price, 1n, MAX_PRICE, 'INVALID_PRICE');
  if (notional(quantity, price) < MIN_ORDER_NOTIONAL) {
    throw new DomainError('ORDER_TOO_SMALL', 'Order notional must be at least 1 USD-SIM.');
  }
}
