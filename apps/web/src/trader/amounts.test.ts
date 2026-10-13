import { describe, expect, it } from 'vitest';
import { amount, orderReview, units } from './amounts.js';

describe('exact trader review', () => {
  it('includes the full buy fee in the commitment and respects the available balance', () => {
    expect(orderReview('BUY', '0.1', '50000', '5005').reservation).toBe('5005.000000000');
    expect(() => orderReview('BUY', '0.1', '50000', '5004.999999999')).toThrow('Insufficient');
  });

  it('keeps a maximum-size commitment exact beyond JavaScript safe integer atoms', () => {
    const review = orderReview('BUY', '100', '100000000', '10010000000');
    expect(review.reservation).toBe('10010000000.000000000');
    expect(review.fee).toBe('10000000.000000000');
    expect(units(review.reservation, 9)).toBe(10010000000000000000n);
  });

  it('reserves only base quantity for a sell and explains the fee through net proceeds', () => {
    const review = orderReview('SELL', '0.4', '50000', '0.4');
    expect(review.reservation).toBe('0.4000');
    expect(review.proceeds).toBe('19980.000000000');
    expect(() => orderReview('SELL', '0.4', '50000', '0.3999')).toThrow('Insufficient');
  });

  it('rejects unsupported precision and a below-minimum order before showing a confirmation', () => {
    expect(() => orderReview('BUY', '0.00010', '50000', '100000')).toThrow();
    expect(() => orderReview('BUY', '0.1', '50000.001', '100000')).toThrow();
    expect(() => orderReview('BUY', '0.0001', '0.01', '100000')).toThrow();
  });

  it('never rounds a signed one-atom journal entry away when grouping display text', () => {
    expect(amount('-100000.000000001')).toBe('-100,000.000000001');
    expect(amount('0.000000001')).toBe('0.000000001');
    expect(amount('1.0000', 4)).toBe('1.0000');
  });
});
