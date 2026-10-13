import { useState } from 'react';
import type { AccountView, WorkspaceOrderView } from '@sandbox/contracts';
import { amount, date, label } from './format';
import type { AdminAction, Trader } from './types';

export function Status({ value }: { value: string }) {
  const tone = ['ACTIVE', 'ACCEPTED', 'TRADING', 'FILLED', 'REDEEMED', 'RUNNING'].includes(value)
    ? 'positive'
    : ['SUSPENDED', 'REJECTED', 'REVOKED', 'FAULT', 'FAULTED', 'ERROR'].includes(value)
      ? 'negative'
      : 'neutral';
  return <span className={`admin-status ${tone}`}>{label(value)}</span>;
}

export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="admin-empty">
      <span aria-hidden="true">◇</span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function AccountInspector({
  account,
  trader,
  systemName,
  loading,
  error,
  locked,
  canGrant,
  fault,
  onAction,
  retry,
}: {
  account: AccountView | null;
  trader: Trader | undefined;
  systemName: string | undefined;
  loading: boolean;
  error: string | null;
  locked: boolean;
  canGrant: boolean;
  fault: boolean;
  onAction: (action: AdminAction) => void;
  retry: () => void;
}) {
  const [tab, setTab] = useState<'orders' | 'fills' | 'activity'>('orders');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [openOnly, setOpenOnly] = useState(true);
  if (!trader && !systemName)
    return (
      <section className="admin-card admin-inspector">
        <Empty
          title="Select a participant"
          description="Inspect exact balances, order states, fills, and journal activity."
        />
      </section>
    );
  const name = trader ? `@${trader.handle}` : (systemName ?? 'System account');
  const rows =
    (openOnly ? account?.openOrders : account?.orders)?.filter(
      (order) => !query || order.id.includes(query.toLowerCase()),
    ) ?? [];
  const actionForOrder = (order: WorkspaceOrderView): AdminAction => ({
    title: 'Cancel order remainder',
    description: `Cancel only the unfilled ${order.remaining} BTC-SIM. Executions already committed remain valid; a fill may complete before cancellation is admitted.`,
    path: `/api/admin/orders/${order.id}/cancel`,
    target: `${name} · ${order.id}`,
    danger: true,
  });

  return (
    <section className="admin-card admin-inspector" aria-label="Account inspection">
      <div className="admin-card-heading">
        <div>
          <p className="admin-eyebrow">Account inspection</p>
          <h2>{name}</h2>
        </div>
        {trader && <Status value={trader.status} />}
      </div>
      {trader && <p className="admin-id">{trader.accountId}</p>}
      {trader?.suspensionReason && (
        <p className="admin-alert warning">
          <strong>Access suspended.</strong> {trader.suspensionReason}
        </p>
      )}
      {trader?.pendingCancellation && (
        <p className="admin-alert danger" role="status">
          Access is revoked. Order cancellations are still pending because accounting recovery is
          required.
        </p>
      )}
      {trader && (
        <div className="admin-account-actions">
          <button
            className="button ghost"
            disabled={locked || !canGrant || trader.status !== 'ACTIVE' || !account || loading}
            title={!canGrant ? 'Grants require a paused, healthy market.' : undefined}
            onClick={() =>
              onAction({
                title: 'Grant virtual funds',
                description:
                  'Issue a positive grant through the accounting journal. Existing reservations and prior records remain unchanged.',
                path: '/api/admin/grants',
                target: name,
                grant: trader,
              })
            }
          >
            Grant funds
          </button>
          <button
            className="button ghost"
            disabled={locked || trader.status !== 'ACTIVE'}
            onClick={() =>
              onAction({
                title: 'Create recovery link',
                description:
                  'Create a single-use link valid for one hour. Earlier unused recovery links become invalid. Using the link changes the password and revokes all existing sessions.',
                path: `/api/admin/traders/${trader.accountId}/recovery`,
                target: name,
                secret: 'recover',
              })
            }
          >
            Recovery link
          </button>
          <button
            className={`button ${trader.status === 'ACTIVE' ? 'danger' : 'ghost'}`}
            disabled={
              locked || (trader.status !== 'ACTIVE' && (trader.pendingCancellation || fault))
            }
            onClick={() =>
              onAction(
                trader.status === 'ACTIVE'
                  ? {
                      title: 'Suspend participant',
                      description:
                        'Immediately revoke access and all login sessions, then cancel unfilled order quantities. Completed fills remain valid. During an accounting fault, cancellations remain visibly pending.',
                      path: `/api/admin/traders/${trader.accountId}/suspend`,
                      target: name,
                      danger: true,
                    }
                  : {
                      title: 'Reinstate participant',
                      description:
                        'Allow the participant to sign in and trade again. Canceled orders are not recreated and starting funds are not repeated.',
                      path: `/api/admin/traders/${trader.accountId}/reinstate`,
                      target: name,
                    },
              )
            }
          >
            {trader.status === 'ACTIVE' ? 'Suspend access' : 'Reinstate'}
          </button>
        </div>
      )}
      {loading && (
        <p className="admin-loading" role="status">
          Refreshing account…
        </p>
      )}
      {error && (
        <div className="admin-alert danger" role="alert">
          <p>{error}</p>
          <button className="button ghost" onClick={retry}>
            Retry account read
          </button>
        </div>
      )}
      {account && (
        <>
          <div className="admin-balances">
            {(['BTC-SIM', 'USD-SIM'] as const).map((asset) => (
              <div className="admin-balance" key={asset}>
                <h3>{asset}</h3>
                <dl>
                  <div>
                    <dt>Available</dt>
                    <dd>{amount(account.balances[asset].available)}</dd>
                  </div>
                  <div>
                    <dt>Reserved</dt>
                    <dd>{amount(account.balances[asset].reserved)}</dd>
                  </div>
                  <div>
                    <dt>Total</dt>
                    <dd>{amount(account.balances[asset].total)}</dd>
                  </div>
                </dl>
              </div>
            ))}
          </div>
          <div className="admin-subnav" aria-label="Account history views">
            {(['orders', 'fills', 'activity'] as const).map((item) => (
              <button
                className={tab === item ? 'selected' : ''}
                aria-pressed={tab === item}
                onClick={() => setTab(item)}
                key={item}
              >
                {item === 'activity' ? 'Balance activity' : label(item)}
              </button>
            ))}
          </div>
          {tab === 'orders' && (
            <>
              <div className="admin-filter-row">
                <div className="admin-segment">
                  <button
                    className={openOnly ? 'selected' : ''}
                    aria-pressed={openOnly}
                    onClick={() => setOpenOnly(true)}
                  >
                    Open orders ({account.openOrders.length})
                  </button>
                  <button
                    className={!openOnly ? 'selected' : ''}
                    aria-pressed={!openOnly}
                    onClick={() => setOpenOnly(false)}
                  >
                    Recent history
                  </button>
                </div>
                <input
                  aria-label="Find order in displayed history"
                  placeholder="Find order ID"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {rows.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <caption className="admin-sr-only">
                      {openOnly ? 'All open orders' : 'Recent order history'}
                    </caption>
                    <thead>
                      <tr>
                        <th>Order / side</th>
                        <th>Limit price</th>
                        <th>Remaining / total</th>
                        <th>State</th>
                        <th>
                          <span className="admin-sr-only">Action</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((order) => (
                        <OrderRow
                          key={order.id}
                          order={order}
                          expanded={expanded === order.id}
                          onExpand={() => setExpanded(expanded === order.id ? null : order.id)}
                          canCancel={!locked && !fault}
                          onCancel={() => onAction(actionForOrder(order))}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title={
                    query
                      ? 'No matching displayed orders'
                      : openOnly
                        ? 'No open orders'
                        : 'No orders yet'
                  }
                  description={
                    query
                      ? 'Search applies to this view only. Clear the filter to see all displayed orders.'
                      : 'Accepted orders and their eventual states will appear here.'
                  }
                />
              )}
              {!openOnly && (
                <p className="admin-history-note">
                  Most recent {account.historyLimit} orders. All currently open orders are available
                  in the Open orders view.
                </p>
              )}
            </>
          )}
          {tab === 'fills' && (
            <>
              {account.fills.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <caption className="admin-sr-only">Recent executions for this account</caption>
                    <thead>
                      <tr>
                        <th>Execution</th>
                        <th>Price</th>
                        <th>Quantity</th>
                        <th>Notional / fee</th>
                        <th>Order</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.fills.map((fill) => (
                        <tr key={`${fill.id}-${fill.orderId}`}>
                          <td>
                            <span className={`admin-side ${fill.side.toLowerCase()}`}>
                              {fill.side}
                            </span>
                            <small>
                              {label(fill.role)} · {date(fill.timestamp)}
                            </small>
                          </td>
                          <td className="admin-number">{amount(fill.price)}</td>
                          <td className="admin-number">{amount(fill.quantity)}</td>
                          <td className="admin-number">
                            {amount(fill.notional)}
                            <small>Fee {amount(fill.fee)} USD-SIM</small>
                          </td>
                          <td>
                            <details>
                              <summary className="admin-link">{fill.orderId.slice(0, 8)}</summary>
                              <span className="admin-id">{fill.orderId}</span>
                              {'makerOrderId' in fill && (
                                <>
                                  <small>Maker order</small>
                                  <span className="admin-id">{String(fill.makerOrderId)}</span>
                                </>
                              )}
                              {'takerOrderId' in fill && (
                                <>
                                  <small>Taker order</small>
                                  <span className="admin-id">{String(fill.takerOrderId)}</span>
                                </>
                              )}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="No executions yet"
                  description="Fills appear only when orders match. Resting orders do not create trading history."
                />
              )}
              <p className="admin-history-note">
                Most recent {account.historyLimit} fills. Prices and notional are in USD-SIM;
                quantities are in BTC-SIM.
              </p>
            </>
          )}
          {tab === 'activity' && (
            <>
              {account.activity.length ? (
                <div className="admin-table-wrap">
                  <table className="admin-table">
                    <caption className="admin-sr-only">Recent balance journal entries</caption>
                    <thead>
                      <tr>
                        <th>Cause</th>
                        <th>Asset / bucket</th>
                        <th>Change</th>
                        <th>Reference</th>
                      </tr>
                    </thead>
                    <tbody>
                      {account.activity.map((entry) => (
                        <tr key={entry.id}>
                          <td className="admin-capitalize">
                            {label(entry.kind)}
                            <small>{date(entry.createdAt)}</small>
                          </td>
                          <td>
                            {entry.asset}
                            <small className="admin-capitalize">{label(entry.bucket)}</small>
                          </td>
                          <td
                            className={`admin-number ${entry.amount.startsWith('-') ? '' : 'admin-positive'}`}
                          >
                            {entry.amount.startsWith('-') ? '' : '+'}
                            {amount(entry.amount)}
                          </td>
                          <td>
                            <details>
                              <summary className="admin-link">
                                {entry.orderId ? 'Order' : 'Command'}{' '}
                                {String(entry.orderId ?? entry.commandId).slice(0, 8)}
                              </summary>
                              <small>Command</small>
                              <span className="admin-id">{entry.commandId}</span>
                              {entry.orderId && (
                                <>
                                  <small>Order</small>
                                  <span className="admin-id">{entry.orderId}</span>
                                </>
                              )}
                            </details>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  title="No balance activity"
                  description="Allocations, grants, reservations, releases, and execution entries appear here."
                />
              )}
              <p className="admin-history-note">
                Most recent {account.historyLimit} journal entries. A reservation transfers
                available funds to reserved funds; it is not a charge.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

function OrderRow({
  order,
  expanded,
  onExpand,
  canCancel,
  onCancel,
}: {
  order: WorkspaceOrderView;
  expanded: boolean;
  onExpand: () => void;
  canCancel: boolean;
  onCancel: () => void;
}) {
  const open = order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED';
  return (
    <>
      <tr>
        <td>
          <span className={`admin-side ${order.side.toLowerCase()}`}>{order.side}</span>
          <button
            className="admin-link"
            onClick={onExpand}
            aria-expanded={expanded}
            aria-label={`Inspect order ${order.id}`}
          >
            {order.id.slice(0, 8)} ↗
          </button>
        </td>
        <td className="admin-number">{amount(order.price)}</td>
        <td className="admin-number">
          {amount(order.remaining)}
          <small>of {amount(order.quantity)}</small>
        </td>
        <td>
          <Status value={order.status} />
        </td>
        <td>
          {open && (
            <button
              className="button ghost admin-small-button"
              disabled={!canCancel}
              onClick={onCancel}
            >
              Cancel remainder
            </button>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="admin-order-detail">
          <td colSpan={5}>
            <dl>
              <div>
                <dt>Order</dt>
                <dd className="admin-id">{order.id}</dd>
              </div>
              <div>
                <dt>Created</dt>
                <dd>{date(order.createdAt)}</dd>
              </div>
              <div>
                <dt>Executed quantity</dt>
                <dd>{amount(order.executedQuantity)} BTC-SIM</dd>
              </div>
              <div>
                <dt>Average execution price</dt>
                <dd>
                  {order.averagePrice === null
                    ? 'No fills'
                    : `${amount(order.averagePrice)} USD-SIM`}
                </dd>
              </div>
              <div>
                <dt>Cumulative fee</dt>
                <dd>{amount(order.cumulativeFee)} USD-SIM</dd>
              </div>
              <div>
                <dt>Currently reserved</dt>
                <dd>
                  {amount(order.reserved)} {order.side === 'BUY' ? 'USD-SIM' : 'BTC-SIM'}
                </dd>
              </div>
              {order.cancelReason && (
                <div>
                  <dt>Cancellation reason</dt>
                  <dd>{order.cancelReason}</dd>
                </div>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
