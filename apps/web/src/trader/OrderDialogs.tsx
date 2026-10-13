import { useEffect, useRef, useState } from 'react';
import type { OrderDetailResponse, WorkspaceOrderView } from '@sandbox/contracts';
import { Dialog } from '../components/ui.js';
import { readableCode, type CommandOutcome } from '../lib/api.js';
import { amount, shortId, stateLabel, timeLabel } from './amounts.js';
import { OrderStatus } from './AccountPanels.js';

export function OrderDetailDialog({
  id,
  cursor,
  close,
  readOrder,
  onCancel,
  disabled,
}: {
  id: string | null;
  cursor: string;
  close: () => void;
  readOrder: (id: string) => Promise<OrderDetailResponse>;
  onCancel: (orders: WorkspaceOrderView[]) => void;
  disabled: boolean;
}) {
  const [detail, setDetail] = useState<OrderDetailResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let current = true;
    if (!id) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setError(null);
    void readOrder(id)
      .then((value) => {
        if (current) setDetail(value);
      })
      .catch(() => {
        if (current) {
          setDetail(null);
          setError('Order detail could not be refreshed. Close and reopen it to try again.');
        }
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [id, cursor, readOrder]);
  const order = detail?.order.id === id ? detail.order : null;
  return (
    <Dialog
      open={id !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Order detail"
      description="Accepted parameters, exact accounting, and the current authoritative outcome."
    >
      {loading && (
        <p className="muted" role="status">
          Refreshing order…
        </p>
      )}
      {error && (
        <p className="trader-notice error" role="alert">
          {error}
        </p>
      )}
      {order && (
        <>
          <div className="trader-order-heading">
            <span className={`trader-side ${order.side.toLowerCase()}`}>
              {stateLabel(order.side)} BTC-SIM
            </span>
            <OrderStatus status={order.status} />
          </div>
          <p className="trader-full-id mono">{order.id}</p>
          <dl className="trader-review-list">
            <div>
              <dt>Order type</dt>
              <dd>
                {order.type === 'MARKET'
                  ? 'Protected market · immediate or cancel'
                  : 'Limit · good until canceled'}
              </dd>
            </div>
            <div>
              <dt>Accepted</dt>
              <dd>
                {new Date(order.createdAt).toLocaleString()} · #{order.sequence}
              </dd>
            </div>
            <div>
              <dt>
                {order.type === 'MARKET'
                  ? `${order.side === 'BUY' ? 'Maximum buy' : 'Minimum sell'} price · guard`
                  : 'Limit price'}
              </dt>
              <dd>{amount(order.price)} USD-SIM</dd>
            </div>
            <div>
              <dt>Submitted quantity</dt>
              <dd>{amount(order.quantity, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Executed quantity</dt>
              <dd>{amount(order.executedQuantity, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>{order.status === 'CANCELED' ? 'Canceled remainder' : 'Remaining quantity'}</dt>
              <dd>{amount(order.remaining, 4)} BTC-SIM</dd>
            </div>
            <div>
              <dt>Average execution price</dt>
              <dd>
                {order.averagePrice === null ? '—' : `≈ ${amount(order.averagePrice)} USD-SIM`}
              </dd>
            </div>
            <div>
              <dt>Cumulative fee</dt>
              <dd>{amount(order.cumulativeFee)} USD-SIM</dd>
            </div>
            <div className="trader-review-total">
              <dt>Currently reserved</dt>
              <dd>
                {amount(order.reserved, order.side === 'BUY' ? 2 : 4)}{' '}
                {order.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM'}
              </dd>
            </div>
          </dl>
          {order.cancelReason && (
            <p className="trader-notice warning">
              Cancellation reason:{' '}
              {order.cancelReason.includes(':')
                ? order.cancelReason
                : readableCode(order.cancelReason)}
            </p>
          )}
          {order.status === 'CANCELED' && (
            <p className="trader-dialog-note">
              The remaining reservation was released. Earlier executions and fees are preserved.
            </p>
          )}
          <h3 className="trader-detail-subhead">Executions</h3>
          {detail?.fills.length ? (
            <div className="trader-table-scroll">
              <table className="trader-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th className="numeric">Quantity</th>
                    <th className="numeric">Price</th>
                    <th className="numeric">Fee · USD-SIM</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.fills.map((fill) => (
                    <tr key={fill.id}>
                      <td>
                        <time dateTime={fill.timestamp}>{timeLabel(fill.timestamp)}</time>
                        <span className="trader-cell-sub">{stateLabel(fill.role)}</span>
                      </td>
                      <td className="numeric">{amount(fill.quantity, 4)}</td>
                      <td className="numeric">{amount(fill.price)}</td>
                      <td className="numeric">{amount(fill.fee)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="trader-dialog-note">This order has no executions.</p>
          )}
          <p className="trader-dialog-note">
            Up to {detail?.historyLimit} execution rows are shown. Quantity, average, and fee
            summaries include every execution. Average price is a display value rounded to 9
            decimals.
          </p>
          <div className="trader-dialog-actions">
            <button className="button ghost" type="button" onClick={close}>
              Close
            </button>
            {['OPEN', 'PARTIALLY_FILLED'].includes(order.status) && (
              <button
                className="button danger"
                disabled={disabled || loading}
                type="button"
                onClick={() => {
                  close();
                  onCancel([order]);
                }}
              >
                Cancel remaining quantity
              </button>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}

export function CancelDialog({
  snapshot,
  close,
  sessionId,
  enabled,
  busy,
  runCommand,
}: {
  snapshot: { sessionId: string; orders: WorkspaceOrderView[] } | null;
  close: () => void;
  sessionId: string;
  enabled: boolean;
  busy: boolean;
  runCommand: (
    path: string,
    body: Record<string, unknown>,
    label: string,
  ) => Promise<CommandOutcome | null>;
}) {
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<{ id: string; text: string }[]>([]);
  const [started, setStarted] = useState(false);
  const latest = useRef({ enabled, sessionId, runCommand });
  latest.current = { enabled, sessionId, runCommand };
  useEffect(() => {
    setResults([]);
    setStarted(false);
  }, [snapshot]);

  async function cancel() {
    if (!snapshot || !enabled || busy || running || snapshot.sessionId !== sessionId) return;
    setRunning(true);
    setStarted(true);
    try {
      for (const order of snapshot.orders) {
        // A confirmed bulk snapshot is a sequence of ordinary commands, so a
        // disconnect or session change must also gate its later submissions.
        if (!latest.current.enabled || latest.current.sessionId !== snapshot.sessionId) break;
        const result = await latest.current.runCommand(
          `/api/orders/${order.id}/cancel`,
          {},
          `Cancel order ${shortId(order.id)}`,
        );
        const text = !result
          ? 'Request not confirmed. Check the command notice; remaining snapshot orders have not been submitted.'
          : result.status === 'REJECTED'
            ? `Rejected: ${stateLabel(result.code ?? 'REJECTED')}`
            : result.order?.status === 'FILLED'
              ? 'Already filled. No remaining quantity could be canceled.'
              : result.order?.status === 'CANCELED'
                ? 'Canceled. Earlier fills are preserved and the remaining reservation is released.'
                : 'Cancellation accepted. The refreshed order shows its authoritative state.';
        setResults((current) => [...current, { id: order.id, text }]);
        if (!result) break;
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <Dialog
      open={snapshot !== null}
      onOpenChange={(open) => {
        if (!open && !running) close();
      }}
      title={
        snapshot?.orders.length === 1
          ? 'Cancel remaining quantity?'
          : `Cancel ${snapshot?.orders.length ?? 0} open orders?`
      }
      description="This confirmation applies only to the listed snapshot. Earlier fills stay valid; orders can fill before cancellation is accepted."
    >
      {snapshot && (
        <>
          <ul className="trader-cancel-snapshot">
            {snapshot.orders.map((order) => (
              <li key={order.id}>
                <span className="mono">{shortId(order.id)}</span>
                <span className={`trader-side ${order.side.toLowerCase()}`}>
                  {stateLabel(order.side)}
                </span>
                <span className="mono">{amount(order.remaining, 4)} BTC-SIM remaining</span>
              </li>
            ))}
          </ul>
          {results.length > 0 && (
            <ul className="trader-cancel-results" aria-live="polite">
              {results.map((result) => (
                <li key={result.id}>
                  <strong className="mono">{shortId(result.id)}</strong> {result.text}
                </li>
              ))}
            </ul>
          )}
          {started && !running && results.length < snapshot.orders.length && (
            <p className="trader-notice warning">
              Resolve the command notice first, then review the updated open orders before canceling
              the rest.
            </p>
          )}
          {!enabled && !started && (
            <p className="trader-notice warning">
              Cancellation is unavailable until the connection is current and accounting is healthy.
            </p>
          )}
          <div className="trader-dialog-actions">
            <button className="button ghost" type="button" disabled={running} onClick={close}>
              {started ? 'Close' : 'Keep orders'}
            </button>
            {!started && (
              <button
                className="button danger"
                type="button"
                disabled={!enabled || busy || running || snapshot.sessionId !== sessionId}
                onClick={() => void cancel()}
              >
                Confirm cancellation
              </button>
            )}
            {running && (
              <span role="status" className="muted">
                Resolving {results.length + 1} of {snapshot.orders.length}…
              </span>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
