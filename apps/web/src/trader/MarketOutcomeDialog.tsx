import { Dialog } from '../components/ui.js';
import { readableCode } from '../lib/api.js';
import { amount, units } from './amounts.js';
import type { MarketOrderOutcome } from './market-order.js';

export function MarketOutcomeDialog({
  outcome,
  close,
}: {
  outcome: MarketOrderOutcome | null;
  close: () => void;
}) {
  return (
    <Dialog
      open={outcome !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Market order outcome"
      description="The confirmed result is final. Unfilled quantity cannot remain on the book."
    >
      {outcome && (
        <>
          <p className="trader-notice success" role="status">
            {units(outcome.filled, 4) === 0n
              ? 'No executions. The full quantity was canceled and all reserved funds were released.'
              : units(outcome.remaining, 4) > 0n
                ? 'Partially filled. The unfilled remainder was canceled and its reservation released.'
                : 'Fully filled. Any excess reservation was released.'}
          </p>
          <dl className="trader-review-list">
            <div>
              <dt>Filled quantity</dt>
              <dd>
                {amount(outcome.filled, 4)} / {amount(outcome.quantity, 4)} BTC-SIM
              </dd>
            </div>
            <div>
              <dt>Canceled remainder</dt>
              <dd>{amount(outcome.remaining, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Average execution price</dt>
              <dd>
                {outcome.averagePrice === null
                  ? 'No executions'
                  : `≈ ${amount(outcome.averagePrice)} USD-SIM`}
              </dd>
            </div>
            <div>
              <dt>Cumulative fee</dt>
              <dd>{amount(outcome.fee)} USD-SIM</dd>
            </div>
            <div>
              <dt>{outcome.side === 'BUY' ? 'Maximum buy price' : 'Minimum sell price'}</dt>
              <dd>{amount(outcome.guardPrice)} USD-SIM</dd>
            </div>
            <div className="trader-review-total">
              <dt>
                {outcome.side === 'BUY' ? 'Total cost including fee' : 'Net proceeds after fee'}
              </dt>
              <dd>{amount(outcome.net)} USD-SIM</dd>
            </div>
          </dl>
          {outcome.cancelReason && (
            <p className="trader-notice warning">{readableCode(outcome.cancelReason)}</p>
          )}
          <p className="trader-dialog-note">
            Order <span className="mono">{outcome.orderId}</span>. Executions and exact fees are
            preserved in your order history. Average price is rounded to 9 decimals.
          </p>
          <div className="trader-dialog-actions">
            <button type="button" className="button primary" onClick={close}>
              Done
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
