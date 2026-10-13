import { useEffect, useState, type FormEvent } from 'react';
import type { AccountView } from '@sandbox/contracts';
import { Dialog } from '../components/ui.js';
import type { CommandOutcome } from '../lib/api.js';
import { amount, orderReview, stateLabel } from './amounts.js';

interface TicketProps {
  account: AccountView;
  sessionId: string;
  enabled: boolean;
  disabledReason: string | null;
  busy: boolean;
  selectedPrice: { price: string; key: number } | null;
  runCommand: (
    path: string,
    body: Record<string, unknown>,
    label: string,
  ) => Promise<CommandOutcome | null>;
}

interface Review {
  sessionId: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  values: ReturnType<typeof orderReview>;
}

export function OrderTicket({
  account,
  sessionId,
  enabled,
  disabledReason,
  busy,
  selectedPrice,
  runCommand,
}: TicketProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const asset = side === 'BUY' ? 'USD-SIM' : 'BTC-SIM';

  useEffect(() => {
    if (selectedPrice) setPrice(selectedPrice.price);
  }, [selectedPrice]);

  useEffect(() => {
    setReview(null);
    setQuantity('');
    setPrice('');
    setError(null);
    setNotice(null);
  }, [sessionId]);

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (!enabled || busy || submitting) return;
    setError(null);
    setNotice(null);
    try {
      const values = orderReview(side, quantity, price, account.balances[asset].available);
      setReview({ sessionId, side, quantity, price, values });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the quantity and limit price.');
    }
  }

  async function submit() {
    if (!review || !enabled || busy || submitting || review.sessionId !== sessionId) return;
    setSubmitting(true);
    try {
      const outcome = await runCommand(
        '/api/orders',
        { side: review.side, quantity: review.quantity, price: review.price },
        `${stateLabel(review.side)} ${review.values.quantity} BTC-SIM`,
      );
      setReview(null);
      if (outcome) {
        if (outcome.status === 'ACCEPTED') {
          setNotice(
            'Order accepted. Its current state, executions, and reservations are shown below.',
          );
          setQuantity('');
        } else
          setError(
            `Order rejected: ${stateLabel(outcome.code ?? 'REJECTED')}. No new funds were reserved.`,
          );
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="trader-panel trader-ticket" aria-labelledby="ticket-heading">
        <div className="trader-panel-header">
          <h2 id="ticket-heading">Place an order</h2>
          <span className="trader-tag">Limit</span>
        </div>
        <form onSubmit={prepare} className="trader-ticket-form">
          <div className="trader-side-toggle" role="group" aria-label="Order side">
            <button
              type="button"
              className={side === 'BUY' ? 'selected buy' : ''}
              aria-pressed={side === 'BUY'}
              onClick={() => {
                setSide('BUY');
                setError(null);
              }}
            >
              Buy
            </button>
            <button
              type="button"
              className={side === 'SELL' ? 'selected sell' : ''}
              aria-pressed={side === 'SELL'}
              onClick={() => {
                setSide('SELL');
                setError(null);
              }}
            >
              Sell
            </button>
          </div>
          <div className="trader-available">
            <span>Available</span>
            <strong>
              {amount(account.balances[asset].available, side === 'BUY' ? 2 : 4)}{' '}
              <small>{asset}</small>
            </strong>
          </div>
          <label className="trader-field" htmlFor="order-price">
            <span>Limit price</span>
            <div className="trader-input-unit">
              <input
                id="order-price"
                name="price"
                value={price}
                onChange={(event) => {
                  setPrice(event.target.value);
                  setError(null);
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                required
                maxLength={64}
                aria-describedby="price-help"
              />
              <span>USD-SIM</span>
            </div>
            <small id="price-help">Per BTC-SIM · increments of 0.01</small>
          </label>
          <label className="trader-field" htmlFor="order-quantity">
            <span>Quantity</span>
            <div className="trader-input-unit">
              <input
                id="order-quantity"
                name="quantity"
                value={quantity}
                onChange={(event) => {
                  setQuantity(event.target.value);
                  setError(null);
                }}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.0000"
                required
                maxLength={64}
                aria-describedby="quantity-help"
              />
              <span>BTC-SIM</span>
            </div>
            <small id="quantity-help">Increments of 0.0001 · maximum 100</small>
          </label>
          <div className="trader-ticket-facts">
            <div>
              <span>Execution fee</span>
              <span>0.10% per side</span>
            </div>
            <div>
              <span>Time in force</span>
              <span>Until filled or canceled</span>
            </div>
          </div>
          <p className="trader-ticket-explainer">
            {side === 'BUY'
              ? 'Buy at your limit price or lower. The full limit commitment and fee are reserved before matching.'
              : 'Sell at your limit price or higher. The full quantity is reserved before matching; fees come from proceeds.'}
          </p>
          {disabledReason && (
            <p className="trader-notice warning" role="status">
              {disabledReason}
            </p>
          )}
          {error && (
            <p className="trader-notice error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="trader-notice success" role="status">
              {notice}
            </p>
          )}
          <button
            className={`button trader-submit ${side.toLowerCase()}`}
            type="submit"
            disabled={!enabled || busy || submitting}
          >
            Review {side === 'BUY' ? 'buy' : 'sell'} order <span aria-hidden="true">→</span>
          </button>
          <p className="trader-ticket-footnote">
            Simulated funds only. Minimum order value: 1 USD-SIM.
          </p>
        </form>
      </section>
      <Dialog
        open={review !== null}
        onOpenChange={(open) => {
          if (!open && !submitting) setReview(null);
        }}
        title={`Review ${review?.side === 'SELL' ? 'sell' : 'buy'} limit order`}
        description="Confirm the exact order you want to submit. The server checks the current market and funds again at acceptance."
      >
        {review && (
          <>
            <dl className="trader-review-list">
              <div>
                <dt>Quantity</dt>
                <dd>{amount(review.values.quantity, 4)} BTC-SIM</dd>
              </div>
              <div>
                <dt>Limit price</dt>
                <dd>{amount(review.price)} USD-SIM</dd>
              </div>
              <div>
                <dt>Fee rate</dt>
                <dd>0.10% of each execution</dd>
              </div>
              <div>
                <dt>{review.side === 'BUY' ? 'Maximum fee' : 'Fee at limit · estimate'}</dt>
                <dd>{amount(review.values.fee)} USD-SIM</dd>
              </div>
              <div className="trader-review-total">
                <dt>{review.side === 'BUY' ? 'Maximum reserved' : 'Quantity reserved'}</dt>
                <dd>
                  {amount(review.values.reservation, review.side === 'BUY' ? 2 : 4)}{' '}
                  {review.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM'}
                </dd>
              </div>
              {review.side === 'SELL' && (
                <div>
                  <dt>Net proceeds at limit · estimate</dt>
                  <dd>{amount(review.values.proceeds)} USD-SIM</dd>
                </div>
              )}
            </dl>
            <p className="trader-dialog-note">
              {review.side === 'BUY'
                ? 'Price improvement releases excess reserved funds. Unfilled quantity stays on the book.'
                : 'A better price can increase both proceeds and fees. Unfilled quantity stays on the book.'}{' '}
              Execution is not guaranteed.
            </p>
            {!enabled && (
              <p className="trader-notice warning">
                {disabledReason ?? 'Waiting for current market data.'}
              </p>
            )}
            <div className="trader-dialog-actions">
              <button
                className="button ghost"
                type="button"
                disabled={submitting}
                onClick={() => setReview(null)}
              >
                Back to edit
              </button>
              <button
                className={`button trader-submit ${review.side.toLowerCase()}`}
                type="button"
                disabled={!enabled || busy || submitting || review.sessionId !== sessionId}
                onClick={() => void submit()}
              >
                {submitting ? 'Submitting…' : `Confirm ${review.side.toLowerCase()} order`}
              </button>
            </div>
          </>
        )}
      </Dialog>
    </>
  );
}
