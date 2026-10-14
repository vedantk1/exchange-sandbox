import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  AccountView,
  PreparedHistoryExportView,
  HistoryPageView,
  HistoryView,
  OrderDetailResponse,
  SessionsView,
  SessionSummaryView,
  WorkspaceView,
} from '@sandbox/contracts';
import { api, errorMessage } from '../lib/api.js';
import { LoadingView } from '../components/ui.js';
import { OrderDetailDialog } from '../trader/OrderDialogs.js';
import { amount, shortId } from '../trader/amounts.js';
import { AccountSearch } from './AccountSearch.js';
import { ExportDialog } from './ExportDialog.js';
import { HistoryRows } from './HistoryRows.js';
import type { HistoryKind } from './types.js';
import './history.css';
import '../trader/trader.css';

const kinds: { id: HistoryKind; label: string }[] = [
  { id: 'orders', label: 'Orders' },
  { id: 'fills', label: 'Executions' },
  { id: 'activity', label: 'Balance activity' },
  { id: 'commands', label: 'Command outcomes' },
];

export function SessionHistory({
  workspace,
  readOrder,
  readAccount,
  initialAccountId,
}: {
  workspace: WorkspaceView;
  readOrder: (id: string) => Promise<OrderDetailResponse>;
  readAccount: (id: string, sessionId?: string) => Promise<AccountView>;
  initialAccountId?: string;
}) {
  const admin = workspace.user.role === 'ADMIN';
  const actorId = workspace.user.accountId;
  const [chosenSession, setChosenSession] = useState<string | null>(null);
  const sessionId = chosenSession ?? workspace.sessionId;
  const [extraSessions, setExtraSessions] = useState<SessionSummaryView[]>([]);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string | null>(
    initialAccountId ?? (admin ? null : actorId),
  );
  const [accountLabel, setAccountLabel] = useState(
    admin ? (initialAccountId ?? 'Choose a participant') : `@${workspace.user.handle}`,
  );
  const [kind, setKind] = useState<HistoryKind>(admin && !initialAccountId ? 'audit' : 'fills');
  const [search, setSearch] = useState('');
  const [side, setSide] = useState('ALL');
  const [status, setStatus] = useState('ALL');
  const [cursor, setCursor] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [orderLookup, setOrderLookup] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<PreparedHistoryExportView | null>(null);
  const exportController = useRef<AbortController | null>(null);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessions = useQuery({
    queryKey: ['sessions', actorId, workspace.sessionId],
    queryFn: ({ signal }) =>
      api<SessionsView>('/api/sessions?limit=100', undefined, signal, actorId),
    retry: false,
  });
  const history = useQuery({
    queryKey: ['session-history', actorId, sessionId, workspace.cursor],
    queryFn: ({ signal }) =>
      api<HistoryView>(`/api/history/${sessionId}`, undefined, signal, actorId),
    retry: false,
  });
  const inspectedAccount = useQuery({
    queryKey: [
      'history-account',
      actorId,
      sessionId,
      accountId,
      sessionId === workspace.sessionId ? workspace.cursor : 'archived',
    ],
    queryFn: () => readAccount(accountId!, sessionId),
    enabled: admin && Boolean(accountId),
    retry: false,
  });
  const scope = `${sessionId}:${accountId}:${kind}:${search}:${side}:${status}`;
  const [pageScope, setPageScope] = useState(scope);
  const page = useQuery({
    queryKey: ['history-page', actorId, sessionId, accountId, kind, cursor, search, side, status],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ kind, limit: '25' });
      if (accountId && admin && kind !== 'audit') params.set('accountId', accountId);
      if (cursor) params.set('cursor', cursor);
      if (search.trim()) params.set('search', search.trim());
      if (kind === 'orders' && side !== 'ALL') params.set('side', side);
      if (kind === 'orders' && status !== 'ALL') params.set('status', status);
      return api<HistoryPageView>(
        `/api/history/${sessionId}/page?${params}`,
        undefined,
        signal,
        actorId,
      );
    },
    enabled: pageScope === scope && (kind === 'audit' || Boolean(accountId)),
    retry: false,
  });
  useEffect(() => {
    exportController.current?.abort();
    setPageScope(scope);
    setCursor(null);
    setPrevious([]);
    setSelectedOrder(null);
    setBundle(null);
    setExportError(null);
  }, [scope]);
  useEffect(() => {
    setExtraSessions([]);
    setSessionCursor(null);
  }, [workspace.sessionId]);
  const availableSessions = [
    ...new Map(
      [...(sessions.data?.sessions ?? []), ...extraSessions].map((session) => [
        session.id,
        session,
      ]),
    ).values(),
  ];
  const currentExportScope = useRef({ sessionId, accountId });
  currentExportScope.current = { sessionId, accountId };
  useEffect(() => () => exportController.current?.abort(), []);
  const session = history.data?.session;
  const archived = session?.state === 'CLOSED';
  const account = admin ? inspectedAccount.data : history.data?.account;
  const pendingAccount = admin && accountId && inspectedAccount.isPending;

  async function loadSessions() {
    const after = sessionCursor ?? sessions.data?.nextCursor;
    if (!after || sessionLoading) return;
    setSessionLoading(true);
    setSessionError(null);
    try {
      const result = await api<SessionsView>(
        `/api/sessions?limit=100&cursor=${encodeURIComponent(after)}`,
        undefined,
        undefined,
        actorId,
      );
      setExtraSessions((old) => [...old, ...result.sessions]);
      setSessionCursor(result.nextCursor);
      if (!result.nextCursor) setSessionCursor('');
    } catch (error) {
      setSessionError(errorMessage(error));
    } finally {
      setSessionLoading(false);
    }
  }
  async function exportHistory() {
    if (exporting || (!accountId && kind !== 'audit')) return;
    setExporting(true);
    setExportError(null);
    const controller = new AbortController();
    exportController.current = controller;
    try {
      const value = await api<PreparedHistoryExportView>(
        `/api/history/${sessionId}/exports`,
        admin && accountId ? { accountId } : {},
        controller.signal,
        actorId,
        45_000,
      );
      if (
        value.sessionId !== sessionId ||
        value.accountId !== (kind === 'audit' && !accountId ? null : accountId)
      )
        throw new Error('Unexpected export scope');
      if (
        currentExportScope.current.sessionId !== sessionId ||
        currentExportScope.current.accountId !== accountId
      )
        return;
      setBundle(value);
    } catch (error) {
      if (!controller.signal.aborted) setExportError(errorMessage(error));
    } finally {
      if (exportController.current === controller) exportController.current = null;
      setExporting(false);
    }
  }

  return (
    <div
      className={`session-history trader-section-stack ${admin ? 'history-embedded' : 'trader-workspace'}`}
    >
      <header className="trader-page-heading">
        <div>
          <p className="trader-eyebrow">PRESERVED TRADING RECORDS</p>
          <h1>Sessions & history</h1>
          <p>Trace orders, executions, exact balance changes, and confirmed outcomes.</p>
        </div>
      </header>
      <section className="trader-panel history-session-panel">
        <div className="history-session-controls">
          <label className="field">
            Trading session
            <select
              aria-label="Trading session"
              value={sessionId}
              onChange={(event) =>
                setChosenSession(
                  event.target.value === workspace.sessionId ? null : event.target.value,
                )
              }
            >
              {!availableSessions.some((item) => item.id === workspace.sessionId) && (
                <option value={workspace.sessionId}>
                  Current · {shortId(workspace.sessionId)}
                </option>
              )}
              {chosenSession && !availableSessions.some((item) => item.id === chosenSession) && (
                <option value={chosenSession}>Selected · {shortId(chosenSession)}</option>
              )}
              {availableSessions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.state === 'CLOSED' ? 'Archived' : 'Current'} · {shortId(item.id)} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          </label>
          {sessionCursor !== '' && (sessionCursor || sessions.data?.nextCursor) && (
            <button
              className="button ghost small"
              disabled={sessionLoading}
              onClick={() => void loadSessions()}
            >
              Load older sessions
            </button>
          )}
          <button
            className="button ghost"
            disabled={exporting || (!accountId && kind !== 'audit')}
            onClick={() => void exportHistory()}
          >
            {exporting ? 'Preparing export…' : 'Export consistent CSV'}
          </button>
        </div>
        {sessions.error && (
          <p className="notice danger" role="alert">
            {errorMessage(sessions.error)}
          </p>
        )}
        {sessionError && (
          <p className="notice danger" role="alert">
            {sessionError}
          </p>
        )}
        {session && (
          <div className={`history-session-state ${archived ? 'archived' : ''}`} role="status">
            <strong>
              {archived ? 'Archived session · read-only' : 'Current session · history view'}
            </strong>
            <span className="mono">{session.id}</span>
            <span>
              {archived && session.closedAt
                ? `Closed ${new Date(session.closedAt).toLocaleString()}. Final balances and prior records are preserved.`
                : 'History views do not submit or cancel orders. Use the trading workspace for current activity.'}
            </span>
          </div>
        )}
        {history.isPending && <LoadingView message="Loading session history…" />}
        {history.error && (
          <p className="notice danger" role="alert">
            {errorMessage(history.error)}
          </p>
        )}
        {exportError && (
          <p className="notice danger" role="alert">
            {exportError}
          </p>
        )}
      </section>
      {admin && (
        <section className="trader-panel history-account-panel">
          <h2>Find an order</h2>
          <p className="muted">Inspect an exact order ID across all sessions and accounts.</p>
          <form
            className="history-session-controls"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                  orderLookup.trim().toLowerCase(),
                )
              )
                setSelectedOrder(orderLookup.trim().toLowerCase());
            }}
          >
            <label className="field">
              Order ID
              <input
                value={orderLookup}
                onChange={(event) => setOrderLookup(event.target.value)}
                placeholder="Full order UUID"
                maxLength={36}
                required
              />
            </label>
            <button
              className="button ghost"
              disabled={
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
                  orderLookup.trim().toLowerCase(),
                )
              }
            >
              Inspect order
            </button>
          </form>
        </section>
      )}
      {admin && (
        <section className="trader-panel history-account-panel">
          <h2>Account scope</h2>
          <p className="muted">{accountLabel}</p>
          <AccountSearch
            actorId={actorId}
            selectedId={accountId}
            refreshKey={workspace.sessionId}
            onSelect={(participant) => {
              setAccountId(participant.accountId);
              setAccountLabel(`@${participant.handle}`);
              if (kind === 'audit') setKind('orders');
            }}
          />
          {workspace.admin && (
            <div className="history-account-results">
              {[
                { id: workspace.admin.overview.feeAccountId, name: 'Fee account' },
                { id: workspace.admin.overview.issuanceAccountId, name: 'Issuance account' },
                {
                  id: workspace.admin.overview.demoMarket?.makerAccountId,
                  name: 'Simulator maker',
                },
                {
                  id: workspace.admin.overview.demoMarket?.takerAccountId,
                  name: 'Simulator taker',
                },
              ]
                .filter((item) => Boolean(item.id))
                .map((item) => (
                  <button
                    className="button ghost small"
                    key={item.id}
                    onClick={() => {
                      setAccountId(item.id!);
                      setAccountLabel(item.name);
                      if (kind === 'audit') setKind('activity');
                    }}
                  >
                    {item.name}
                  </button>
                ))}
              <button
                className="button ghost small"
                onClick={() => {
                  setAccountId(null);
                  setAccountLabel('Administrator audit');
                  setKind('audit');
                }}
              >
                Administrator audit
              </button>
            </div>
          )}
        </section>
      )}
      {pendingAccount && <LoadingView message="Loading scoped account…" />}
      {inspectedAccount.error && (
        <p className="notice danger" role="alert">
          {errorMessage(inspectedAccount.error)}
        </p>
      )}
      {account && (
        <>
          <p className="history-balance-caption">
            {archived
              ? 'Final balances at session close'
              : 'Balances from the selected session snapshot'}{' '}
            · {accountLabel}
          </p>
          <section className="trader-panel">
            <div className="trader-table-scroll">
              <table className="trader-table">
                <caption className="sr-only">Selected session account balances</caption>
                <thead>
                  <tr>
                    <th>Asset</th>
                    <th className="numeric">Available</th>
                    <th className="numeric">Reserved</th>
                    <th className="numeric">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {(['BTC-SIM', 'USD-SIM'] as const).map((asset) => (
                    <tr key={asset}>
                      <td>{asset}</td>
                      {(['available', 'reserved', 'total'] as const).map((bucket) => (
                        <td className="numeric" key={bucket}>
                          {amount(account.balances[asset][bucket], asset === 'BTC-SIM' ? 4 : 2)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
      {!admin && history.data && !account && (
        <p className="notice warning">
          You did not participate in this session. Choose a session with your trading records.
        </p>
      )}
      <section className="trader-panel">
        <div className="trader-panel-header history-record-toolbar">
          <div className="trader-tabs" role="group" aria-label="Session history views">
            {[
              ...kinds,
              ...(admin ? [{ id: 'audit' as const, label: 'Administrator audit' }] : []),
            ].map((item) => (
              <button
                key={item.id}
                aria-pressed={kind === item.id}
                className={kind === item.id ? 'active' : ''}
                onClick={() => setKind(item.id)}
                disabled={item.id !== 'audit' && !accountId}
              >
                {item.label}
              </button>
            ))}
          </div>
          <button
            className="button ghost small"
            disabled={page.isFetching}
            onClick={() => {
              setCursor(null);
              setPrevious([]);
              void page.refetch();
            }}
          >
            Refresh records
          </button>
        </div>
        <div className="history-filters">
          <label className="field">
            Find record by ID
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              maxLength={80}
              placeholder="Search complete selected history"
            />
          </label>
          {kind === 'orders' && (
            <label className="field">
              Record side
              <select
                aria-label="Record side"
                value={side}
                onChange={(event) => setSide(event.target.value)}
              >
                <option value="ALL">Both sides</option>
                <option value="BUY">Buy</option>
                <option value="SELL">Sell</option>
              </select>
            </label>
          )}
          {kind === 'orders' && (
            <label className="field">
              Record status
              <select
                aria-label="Record status"
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                <option value="ALL">All statuses</option>
                <option value="OPEN">Open</option>
                <option value="PARTIALLY_FILLED">Partially filled</option>
                <option value="FILLED">Filled</option>
                <option value="CANCELED">Canceled</option>
              </select>
            </label>
          )}
        </div>
        {page.isFetching && <LoadingView message="Loading history records…" />}
        {page.error && (
          <p className="notice danger" role="alert">
            {errorMessage(page.error)}
          </p>
        )}
        {page.data && (
          <HistoryRows kind={kind} items={page.data.items} onSelect={setSelectedOrder} />
        )}
        {!accountId && kind !== 'audit' && (
          <p className="trader-empty">Choose an account to inspect its records.</p>
        )}
        <div className="history-pagination">
          <button
            className="button ghost small"
            disabled={!previous.length || page.isFetching}
            onClick={() => {
              setCursor(previous.at(-1) ?? null);
              setPrevious((values) => values.slice(0, -1));
            }}
          >
            Previous records
          </button>
          <span>Page {previous.length + 1} · 25 records per page</span>
          <button
            className="button ghost small"
            disabled={!page.data?.nextCursor || page.isFetching}
            onClick={() => {
              if (!page.data?.nextCursor) return;
              setPrevious((values) => [...values, cursor]);
              setCursor(page.data.nextCursor);
            }}
          >
            Next records
          </button>
        </div>
        {page.data && (
          <p className="trader-panel-note">
            Page read at {new Date(page.data.asOf).toLocaleString()}.{' '}
            {archived
              ? 'Archived financial records are final.'
              : 'Current session pages reflect activity at each read; export a bundle for one consistent boundary.'}
          </p>
        )}
      </section>
      <OrderDetailDialog
        id={selectedOrder}
        cursor={history.data?.cursor ?? workspace.cursor}
        close={() => setSelectedOrder(null)}
        readOrder={readOrder}
        onCancel={() => undefined}
        disabled
        readOnly
      />
      {bundle && (
        <ExportDialog
          bundle={bundle}
          close={() => setBundle(null)}
          regenerate={() => {
            setBundle(null);
            void exportHistory();
          }}
        />
      )}
    </div>
  );
}
