import { describe, expect, it } from 'vitest';
import { marketOrderOutcome, previewClock, previewRemaining } from './market-order.js';
import type { CommandOutcome } from '../lib/api.js';

describe('protected market review timing', () => {
  it('subtracts transport time without trusting the browser wall clock relative to the server', () => {
    const clock = previewClock('2026-01-01T12:00:00Z', '2026-01-01T12:00:10Z', 100, 1_000);
    expect(previewRemaining(clock, 2_100, 3_000)).toBe(8_000);
    expect(previewRemaining(clock, 10_100, 11_000)).toBe(0);
  });

  it('cannot extend the window after a backwards clock correction or suspended monotonic clock', () => {
    const clock = previewClock('2026-01-01T12:00:00Z', '2026-01-01T12:00:10Z', 100, 1_000);
    expect(previewRemaining(clock, 10_101, -90_000)).toBe(0);
    expect(previewRemaining(clock, 150, 12_000)).toBe(0);
  });

  it('fails closed for invalid server timestamps and never grants a window longer than ten seconds', () => {
    expect(previewRemaining(previewClock('invalid', 'invalid', 0, 0), 0, 0)).toBe(0);
    expect(previewClock('2026-01-01T12:00:00Z', '2026-01-01T12:00:20Z', 0, 0).duration).toBe(
      10_000,
    );
  });
});

describe('terminal market receipt presentation', () => {
  const receipt: CommandOutcome = {
    commandId: 'command',
    sessionId: 'session',
    sequence: '10',
    status: 'ACCEPTED',
    order: {
      id: 'order',
      type: 'MARKET',
      side: 'BUY',
      quantity: '0.1000',
      remaining: '0.0250',
      price: '52500.00',
      cancelReason: 'INSUFFICIENT_LIQUIDITY',
    },
    fills: [
      {
        quantity: '0.0500',
        price: '50000.00',
        notional: '2500.000000000',
        buyerFee: '2.500000000',
        sellerFee: '2.500000000',
      },
      {
        quantity: '0.0250',
        price: '51000.00',
        notional: '1275.000000000',
        buyerFee: '1.275000000',
        sellerFee: '1.275000000',
      },
    ],
  };

  it('shows exact partial execution totals, a rounded weighted average, and the canceled remainder', () => {
    expect(marketOrderOutcome(receipt)).toMatchObject({
      filled: '0.0750',
      remaining: '0.0250',
      fee: '3.775000000',
      notional: '3775.000000000',
      net: '3778.775000000',
      averagePrice: '50333.333333333',
      cancelReason: 'INSUFFICIENT_LIQUIDITY',
    });
  });

  it('deducts sell fees from proceeds and distinguishes a zero-fill terminal result', () => {
    expect(
      marketOrderOutcome({ ...receipt, order: { ...receipt.order!, side: 'SELL' } })?.net,
    ).toBe('3771.225000000');
    expect(
      marketOrderOutcome({
        ...receipt,
        order: { ...receipt.order!, remaining: '0.1000', cancelReason: 'PRICE_GUARD_REACHED' },
        fills: [],
      }),
    ).toMatchObject({
      filled: '0.0000',
      fee: '0.000000000',
      net: '0.000000000',
      averagePrice: null,
      remaining: '0.1000',
    });
  });

  it('does not fabricate an execution outcome for a rejected or legacy limit receipt', () => {
    expect(marketOrderOutcome({ ...receipt, status: 'REJECTED' })).toBeNull();
    const legacyOrder = { ...receipt.order! };
    delete legacyOrder.type;
    expect(marketOrderOutcome({ ...receipt, order: legacyOrder })).toBeNull();
  });
});
