import {
  assertOrderSubmission,
  buyReservation,
  fee,
  formatQuantity,
  formatQuote,
  notional,
  parsePrice,
  parseQuantity,
  parseQuote,
} from '@sandbox/domain';

/** Display grouping never rounds away financial precision. */
export function amount(value: string, minimumDecimals = 2): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const decimals = fraction.replace(/0+$/, '').padEnd(minimumDecimals, '0');
  return `${integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${decimals ? `.${decimals}` : ''}`;
}

export function units(value: string, decimals: number): bigint {
  const [integer = '0', fraction = ''] = value.replace(/^-/, '').split('.');
  const result = BigInt(integer + fraction.padEnd(decimals, '0'));
  return value.startsWith('-') ? -result : result;
}

export function orderReview(
  side: 'BUY' | 'SELL',
  quantity: string,
  price: string,
  available: string,
) {
  const size = parseQuantity(quantity);
  const limit = parsePrice(price);
  assertOrderSubmission(size, limit);
  const quote = notional(size, limit);
  const charge = fee(size, limit);
  const hold = side === 'BUY' ? buyReservation(size, limit) : size;
  const funds = side === 'BUY' ? parseQuote(available) : units(available, 4);
  if (hold > funds)
    throw new Error(`Insufficient available ${side === 'BUY' ? 'USD-SIM' : 'BTC-SIM'}.`);
  return {
    quantity: formatQuantity(size),
    notional: formatQuote(quote),
    fee: formatQuote(charge),
    reservation: side === 'BUY' ? formatQuote(hold) : formatQuantity(hold),
    proceeds: formatQuote(quote - charge),
  };
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

export function stateLabel(state: string): string {
  return state
    .toLowerCase()
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function timeLabel(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}
