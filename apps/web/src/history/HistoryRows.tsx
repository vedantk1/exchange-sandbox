import type {
  ActivityView,
  CommandHistoryView,
  HistoryPageView,
  WorkspaceFillView,
  WorkspaceOrderView,
  WorkspaceView,
} from '@sandbox/contracts';
import { ActivityTable, OrdersTable, OrderStatus } from '../trader/AccountPanels.js';
import { amount, shortId, stateLabel, timeLabel } from '../trader/amounts.js';
import type { HistoryKind } from './types.js';

type AuditRow = NonNullable<WorkspaceView['admin']>['audit'][number];
export function HistoryRows({
  kind,
  items,
  onSelect,
}: {
  kind: HistoryKind;
  items: HistoryPageView['items'];
  onSelect: (id: string) => void;
}) {
  if (!items.length)
    return (
      <div className="trader-empty">
        <strong>No matching records</strong>
        <p>Choose another view or clear the filters.</p>
      </div>
    );
  if (kind === 'orders')
    return (
      <OrdersTable
        orders={items as WorkspaceOrderView[]}
        onSelect={onSelect}
        onCancel={() => undefined}
        disabled
        readOnly
      />
    );
  if (kind === 'activity')
    return <ActivityTable activity={items as ActivityView[]} onSelect={onSelect} />;
  if (kind === 'fills')
    return (
      <div className="trader-table-scroll">
        <table className="trader-table">
          <caption className="sr-only">Executions in the selected session</caption>
          <thead>
            <tr>
              <th>Time / order</th>
              <th>Side / role</th>
              <th className="numeric">Quantity · BTC-SIM</th>
              <th className="numeric">Price · USD-SIM</th>
              <th className="numeric">Notional · USD-SIM</th>
              <th className="numeric">Fee · USD-SIM</th>
            </tr>
          </thead>
          <tbody>
            {(items as WorkspaceFillView[]).map((fill) => (
              <tr key={`${fill.id}:${fill.orderId}`}>
                <td>
                  <time dateTime={fill.timestamp}>{timeLabel(fill.timestamp)}</time>
                  <button
                    className="trader-link trader-cell-sub mono"
                    onClick={() => onSelect(fill.orderId)}
                  >
                    {shortId(fill.orderId)} ↗
                  </button>
                </td>
                <td>
                  <span className={`trader-side ${fill.side.toLowerCase()}`}>
                    {stateLabel(fill.side)}
                  </span>
                  <span className="trader-cell-sub">{stateLabel(fill.role)}</span>
                </td>
                <td className="numeric">{amount(fill.quantity, 4)}</td>
                <td className="numeric">{amount(fill.price)}</td>
                <td className="numeric">{amount(fill.notional)}</td>
                <td className="numeric">{amount(fill.fee)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  if (kind === 'commands')
    return (
      <div className="trader-table-scroll">
        <table className="trader-table">
          <caption className="sr-only">Durable command outcomes</caption>
          <thead>
            <tr>
              <th>Time</th>
              <th>Command</th>
              <th>Sequence</th>
              <th>Outcome</th>
              <th>Order / reason</th>
            </tr>
          </thead>
          <tbody>
            {(items as CommandHistoryView[]).map((command) => (
              <tr key={command.commandId}>
                <td>
                  <time dateTime={command.createdAt}>{timeLabel(command.createdAt)}</time>
                </td>
                <td className="mono" title={command.commandId}>
                  {shortId(command.commandId)}
                </td>
                <td className="mono">#{command.sequence}</td>
                <td>
                  <OrderStatus status={command.status} />
                </td>
                <td>
                  {command.orderId ? (
                    <button className="trader-link mono" onClick={() => onSelect(command.orderId!)}>
                      {shortId(command.orderId)} ↗
                    </button>
                  ) : command.code ? (
                    stateLabel(command.code)
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <div className="trader-table-scroll">
      <table className="trader-table">
        <caption className="sr-only">Administrator decisions in selected session</caption>
        <thead>
          <tr>
            <th>Time / action</th>
            <th>Target</th>
            <th>Reason</th>
            <th>Recorded result</th>
          </tr>
        </thead>
        <tbody>
          {(items as AuditRow[]).map((entry) => (
            <tr key={entry.id}>
              <td>
                {stateLabel(entry.action)}
                <span className="trader-cell-sub">{timeLabel(entry.createdAt)}</span>
              </td>
              <td className="mono">{entry.targetId ?? 'Exchange'}</td>
              <td>{entry.reason}</td>
              <td>
                <details>
                  <summary className="trader-link">
                    {String(entry.result.status ?? 'RECORDED')}
                  </summary>
                  <pre className="history-result">{JSON.stringify(entry.result, null, 2)}</pre>
                  <span className="trader-cell-sub mono">{entry.commandId}</span>
                </details>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
