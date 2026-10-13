import { useEffect, useState } from 'react';
import type { MarketPreviewView } from '@sandbox/contracts';
import { formatQuote } from '@sandbox/domain';
import { Dialog } from '../components/ui.js';
import { readableCode } from '../lib/api.js';
import { amount, units } from './amounts.js';
import { previewRemaining, type PreviewClock } from './market-order.js';

export interface MarketReview {
  preview: MarketPreviewView;
  clock: PreviewClock;
}

export function MarketReviewDialog({
  review,
  enabled,
  busy,
  loading,
  disabledReason,
  available,
  error,
  close,
  refresh,
  confirm,
}: {
  review: MarketReview | null;
  enabled: boolean;
  busy: boolean;
  loading: boolean;
  disabledReason: string | null;
  available: string;
  error: string | null;
  close: () => void;
  refresh: () => void;
  confirm: () => void;
}) {
  const [remaining, setRemaining] = useState(0);
  useEffect(() => {
    if (!review) return;
    const update = () =>
      setRemaining(previewRemaining(review.clock, performance.now(), Date.now()));
    update();
    const timer = setInterval(update, 100);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [review]);
  const preview = review?.preview;
  const expired = remaining <= 0;
  const fundsSufficient =
    !preview ||
    units(preview.reservation.amount, preview.side === 'BUY' ? 9 : 4) <=
      units(available, preview.side === 'BUY' ? 9 : 4);
  return (
    <Dialog
      open={review !== null}
      onOpenChange={(open) => {
        if (!open && !loading) close();
      }}
      title={`Review ${preview?.side === 'SELL' ? 'sell' : 'buy'} protected market order`}
      description="Review the fixed 5% price guard. Estimates may change before execution; your confirmed guard cannot change."
    >
      {preview && (
        <>
          <p className={`trader-notice ${expired ? 'warning' : ''}`} role="status">
            {loading
              ? 'Requesting a new preview…'
              : expired
                ? 'Preview expired. Request a new preview before confirming.'
                : `Preview expires in ${Math.ceil(remaining / 1000)} seconds. No funds are reserved yet.`}
          </p>
          <dl className="trader-review-list">
            <div>
              <dt>Quantity</dt>
              <dd>{amount(preview.quantity, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Reference price</dt>
              <dd>{amount(preview.referencePrice)} USD-SIM</dd>
            </div>
            <div className="trader-review-total">
              <dt>
                {preview.side === 'BUY' ? 'Maximum buy price' : 'Minimum sell price'} · 5% guard
              </dt>
              <dd>{amount(preview.guardPrice)} USD-SIM</dd>
            </div>
            <div>
              <dt>Estimated fill</dt>
              <dd>{amount(preview.estimatedFilledQuantity, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Estimated unfilled quantity</dt>
              <dd>{amount(preview.estimatedRemainingQuantity, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Estimated average price</dt>
              <dd>
                {preview.estimatedAveragePrice === null
                  ? 'No executions'
                  : `≈ ${amount(preview.estimatedAveragePrice)} USD-SIM`}
              </dd>
            </div>
            <div>
              <dt>Estimated fee · 0.10%</dt>
              <dd>{amount(preview.estimatedFee)} USD-SIM</dd>
            </div>
            <div>
              <dt>{preview.side === 'BUY' ? 'Estimated total cost' : 'Estimated net proceeds'}</dt>
              <dd>
                {amount(
                  formatQuote(
                    units(preview.estimatedNotional, 9) +
                      (preview.side === 'BUY' ? 1n : -1n) * units(preview.estimatedFee, 9),
                  ),
                )}{' '}
                USD-SIM
              </dd>
            </div>
            <div className="trader-review-total">
              <dt>{preview.side === 'BUY' ? 'Maximum reserved' : 'Quantity reserved'}</dt>
              <dd>
                {amount(preview.reservation.amount, preview.side === 'BUY' ? 2 : 4)}{' '}
                {preview.reservation.asset}
              </dd>
            </div>
          </dl>
          {preview.estimatedCancelReason && (
            <p className="trader-notice warning">
              Estimated outcome: {readableCode(preview.estimatedCancelReason)}
            </p>
          )}
          <p className="trader-dialog-note">
            This preview does not reserve liquidity. Matching uses the current book within the
            displayed guard. Any unfilled quantity is canceled immediately and unused reservations
            are released. A new preview requires a new confirmation.
          </p>
          {(!enabled || disabledReason) && (
            <p className="trader-notice warning">
              {disabledReason ?? 'Waiting for current market data.'}
            </p>
          )}
          {!fundsSufficient && (
            <p className="trader-notice warning">
              This order requires{' '}
              {amount(preview.reservation.amount, preview.side === 'BUY' ? 2 : 4)}{' '}
              {preview.reservation.asset} available for its full reservation. Your current available
              balance is {amount(available, preview.side === 'BUY' ? 2 : 4)}.
            </p>
          )}
          {error && (
            <p className="trader-notice error" role="alert">
              {error}
            </p>
          )}
          <div className="trader-dialog-actions">
            <button type="button" className="button ghost" disabled={loading} onClick={close}>
              Back to edit
            </button>
            {expired && (
              <button
                type="button"
                className="button primary"
                disabled={!enabled || busy || loading}
                onClick={refresh}
              >
                {loading ? 'Refreshing…' : 'Refresh preview'}
              </button>
            )}
            <button
              type="button"
              className={`button trader-submit ${preview.side.toLowerCase()}`}
              disabled={!enabled || busy || loading || expired || !fundsSufficient}
              onClick={confirm}
            >
              Confirm {preview.side.toLowerCase()} order
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
