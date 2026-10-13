import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AccountView, MarketPreviewView } from '@sandbox/contracts';
import { DomainError, formatQuantity, parseQuantity } from '@sandbox/domain';
import { Dialog } from '../components/ui.js';
import { errorMessage, readableCode, type CommandOutcome } from '../lib/api.js';
import { amount, orderReview, stateLabel, units } from './amounts.js';
import { MarketReviewDialog, type MarketReview } from './MarketReviewDialog.js';
import { previewClock, previewRemaining } from './market-order.js';

interface TicketProps {
  account: AccountView;
  sessionId: string;
  enabled: boolean;
  disabledReason: string | null;
  busy: boolean;
  selectedPrice: { price: string; key: number } | null;
  previewMarket: (body: {
    sessionId: string;
    side: 'BUY' | 'SELL';
    quantity: string;
  }) => Promise<MarketPreviewView>;
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
  previewMarket,
  runCommand,
}: TicketProps) {
  const [side, setSide] = useState<'BUY' | 'SELL'>('BUY');
  const [type, setType] = useState<'LIMIT' | 'MARKET'>('LIMIT');
  const [quantity, setQuantity] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [marketReview, setMarketReview] = useState<MarketReview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewVersion = useRef(0);
  const liveSession = useRef(sessionId);
  liveSession.current = sessionId;
  const asset = side === 'BUY' ? 'USD-SIM' : 'BTC-SIM';

  useEffect(() => {
    if (selectedPrice) setPrice(selectedPrice.price);
  }, [selectedPrice]);

  useEffect(() => {
    previewVersion.current++;
    setMarketReview(null);
    setPreviewing(false);
    setReview(null);
    setQuantity('');
    setPrice('');
    setError(null);
    setNotice(null);
  }, [sessionId]);
  useEffect(
    () => () => {
      previewVersion.current++;
    },
    [],
  );

  async function prepareMarket() {
    if (!enabled || busy || submitting || previewing) return;
    const version = ++previewVersion.current;
    setError(null);
    setNotice(null);
    setPreviewing(true);
    const startedAt = performance.now();
    const wallStartedAt = Date.now();
    try {
      const requestedQuantity = formatQuantity(parseQuantity(quantity));
      const preview = await previewMarket({
        sessionId,
        side,
        quantity: requestedQuantity,
      });
      if (version !== previewVersion.current || liveSession.current !== sessionId) return;
      if (
        preview.sessionId !== sessionId ||
        preview.side !== side ||
        preview.quantity !== requestedQuantity
      ) {
        setError('The preview does not match this order. Request a new preview.');
        return;
      }
      setMarketReview({
        preview,
        clock: previewClock(preview.createdAt, preview.expiresAt, startedAt, wallStartedAt),
      });
    } catch (cause) {
      if (version === previewVersion.current)
        setError(cause instanceof DomainError ? cause.message : errorMessage(cause));
    } finally {
      if (version === previewVersion.current) setPreviewing(false);
    }
  }

  function prepare(event: FormEvent) {
    event.preventDefault();
    if (!enabled || busy || submitting) return;
    setError(null);
    setNotice(null);
    if (type === 'MARKET') {
      void prepareMarket();
      return;
    }
    try {
      const values = orderReview(side, quantity, price, account.balances[asset].available);
      setReview({ sessionId, side, quantity, price, values });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the quantity and limit price.');
    }
  }

  async function submitMarket() {
    if (
      !marketReview ||
      !enabled ||
      busy ||
      submitting ||
      previewing ||
      marketReview.preview.sessionId !== sessionId
    )
      return;
    if (previewRemaining(marketReview.clock, performance.now(), Date.now()) <= 0) {
      setError('This preview expired. Refresh it and review the new guard before confirming.');
      return;
    }
    const confirmed = marketReview.preview;
    const decimals = confirmed.side === 'BUY' ? 9 : 4;
    if (
      units(confirmed.reservation.amount, decimals) >
      units(account.balances[confirmed.reservation.asset].available, decimals)
    )
      return;
    setSubmitting(true);
    setMarketReview(null);
    try {
      const outcome = await runCommand(
        '/api/orders/market',
        { previewId: confirmed.previewId },
        `${stateLabel(confirmed.side)} ${confirmed.quantity} BTC-SIM at market with a fixed guard`,
      );
      if (outcome?.status === 'ACCEPTED') {
        setQuantity('');
        setNotice(
          'Market order completed. Review the final executions and any canceled remainder in the outcome.',
        );
      } else if (outcome) {
        setError(readableCode(outcome.code ?? 'REJECTED'));
      }
    } finally {
      setSubmitting(false);
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
          <span className="trader-tag">{type === 'MARKET' ? '5% guard' : 'Limit'}</span>
        </div>
        <form onSubmit={prepare} className="trader-ticket-form">
          <div
            className="trader-side-toggle trader-type-toggle"
            role="group"
            aria-label="Order type"
          >
            {(['LIMIT', 'MARKET'] as const).map((option) => (
              <button
                key={option}
                type="button"
                disabled={previewing || submitting}
                className={type === option ? 'selected' : ''}
                aria-pressed={type === option}
                onClick={() => {
                  setType(option);
                  setError(null);
                  setNotice(null);
                }}
              >
                {option === 'LIMIT' ? 'Limit' : 'Protected market'}
              </button>
            ))}
          </div>
          <div className="trader-side-toggle" role="group" aria-label="Order side">
            <button
              type="button"
              className={side === 'BUY' ? 'selected buy' : ''}
              aria-pressed={side === 'BUY'}
              disabled={previewing || submitting}
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
              disabled={previewing || submitting}
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
          {type === 'LIMIT' && (
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
          )}
          <label className="trader-field" htmlFor="order-quantity">
            <span>Quantity</span>
            <div className="trader-input-unit">
              <input
                id="order-quantity"
                name="quantity"
                value={quantity}
                disabled={previewing || submitting}
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
              <span>{type === 'MARKET' ? 'Immediate or cancel' : 'Until filled or canceled'}</span>
            </div>
          </div>
          <p className="trader-ticket-explainer">
            {type === 'MARKET'
              ? 'Trade immediately within a fixed 5% price guard. Review a preview valid for 10 seconds; any unfilled quantity is canceled.'
              : side === 'BUY'
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
            disabled={!enabled || busy || submitting || previewing}
          >
            {previewing ? 'Preparing preview…' : `Review ${side === 'BUY' ? 'buy' : 'sell'} order`}{' '}
            <span aria-hidden="true">→</span>
          </button>
          <p className="trader-ticket-footnote">
            Simulated funds only. Minimum order value: 1 USD-SIM.
          </p>
        </form>
      </section>
      <MarketReviewDialog
        review={marketReview}
        enabled={enabled && marketReview?.preview.sessionId === sessionId}
        busy={busy || submitting}
        loading={previewing}
        disabledReason={disabledReason}
        available={account.balances[marketReview?.preview.reservation.asset ?? asset].available}
        error={error}
        close={() => {
          setMarketReview(null);
          setError(null);
        }}
        refresh={() => void prepareMarket()}
        confirm={() => void submitMarket()}
      />
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
