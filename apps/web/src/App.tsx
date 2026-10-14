import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useLayoutEffect,
} from 'react';
import { Navigate, NavLink, Route, Routes, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountView, MarketPreviewView, OrderDetailResponse } from '@sandbox/contracts';
import {
  Activity,
  ArrowUpRight,
  CircleHelp,
  History,
  KeyRound,
  Layers3,
  LayoutDashboard,
  ListOrdered,
  LogOut,
  RefreshCw,
  Wallet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { AuthScreen } from './auth/AuthScreen.js';
import { Dialog, LoadingView } from './components/ui.js';
import {
  api,
  ApiError,
  errorMessage,
  readableCode,
  type User,
  type CommandOutcome,
} from './lib/api.js';
import { CommandRunner } from './lib/commands.js';
import { useWorkspace } from './lib/workspace.js';
import { marketOrderOutcome, type MarketOrderOutcome } from './trader/market-order.js';

const SessionHistory = lazy(() =>
  import('./history/SessionHistory.js').then((module) => ({ default: module.SessionHistory })),
);

const TraderWorkspace = lazy(() =>
  import('./trader/index.js').then((module) => ({ default: module.TraderWorkspace })),
);
const AdminWorkspace = lazy(() =>
  import('./admin/index.js').then((module) => ({ default: module.AdminWorkspace })),
);
const MarketOutcomeDialog = lazy(() =>
  import('./trader/MarketOutcomeDialog.js').then((module) => ({
    default: module.MarketOutcomeDialog,
  })),
);

export function App() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>('/api/auth/session')).user;
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null;
        throw error;
      }
    },
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const login = (user: User) => {
    client.clear();
    client.setQueryData(['session'], user);
  };
  const unauthorized = useCallback(() => {
    client.clear();
    client.setQueryData(['session'], null);
    navigate('/login', { replace: true });
  }, [client, navigate]);
  if (session.isPending) return <LoadingView message="Checking your session…" />;
  if (session.error)
    return (
      <main className="standalone-error">
        <h1>Exchange unavailable</h1>
        <p>{errorMessage(session.error)}</p>
        <button className="button primary" onClick={() => void session.refetch()}>
          Try again
        </button>
      </main>
    );
  if (session.data)
    return (
      <AuthenticatedWorkspace
        key={session.data.accountId}
        user={session.data}
        onUnauthorized={unauthorized}
      />
    );
  return (
    <Routes>
      <Route path="/login" element={<AuthScreen key="login" mode="login" onLogin={login} />} />
      <Route path="/join" element={<AuthScreen key="join" mode="join" onLogin={login} />} />
      <Route
        path="/recover"
        element={<AuthScreen key="recover" mode="recover" onLogin={login} />}
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}

function AuthenticatedWorkspace({
  user,
  onUnauthorized,
}: {
  user: User;
  onUnauthorized: () => void;
}) {
  const workspace = useWorkspace(user, onUnauthorized);
  const [version, setVersion] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const runner = useMemo(
    () =>
      new CommandRunner(
        user.accountId,
        {
          getItem: (key) => sessionStorage.getItem(key),
          setItem: (key, value) => sessionStorage.setItem(key, value),
          removeItem: (key) => sessionStorage.removeItem(key),
        },
        <T,>(path: string, body?: Record<string, unknown>) =>
          api<T>(path, body, undefined, user.accountId),
        () => {
          if (mounted.current) setVersion((value) => value + 1);
        },
      ),
    [user.accountId],
  );
  const [handoff, setHandoff] = useState<{ token: string; recovery: boolean } | null>(null);
  const readAccount = useCallback(
    (id: string, sessionId?: string) =>
      api<AccountView>(
        `/api/admin/traders/${id}/workspace${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
        undefined,
        undefined,
        user.accountId,
      ),
    [user.accountId],
  );
  const readOrder = useCallback(
    (id: string) =>
      api<OrderDetailResponse>(
        `/api/${user.role === 'ADMIN' ? 'admin/' : ''}orders/${id}`,
        undefined,
        undefined,
        user.accountId,
      ),
    [user.accountId],
  );
  const previewMarket = useCallback(
    (body: { sessionId: string; side: 'BUY' | 'SELL'; quantity: string }) =>
      api<MarketPreviewView>('/api/orders/market/preview', body, undefined, user.accountId),
    [user.accountId],
  );
  const [marketOutcome, setMarketOutcome] = useState<MarketOrderOutcome | null>(null);
  const [notice, setNotice] = useState<{ message: string; bad: boolean } | null>(null);
  const [settings, setSettings] = useState(false);
  const [rules, setRules] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const connected = workspace.connected;
  const notifyResult = useCallback(
    async (result: CommandOutcome | null) => {
      if (result) {
        const execution = marketOrderOutcome(result);
        if (execution) setMarketOutcome(execution);
        setNotice({
          message:
            result.status === 'REJECTED'
              ? readableCode(result.code ?? 'COMMAND_REJECTED')
              : result.data?.ok === false
                ? 'Reconciliation found an accounting problem. Trading remains halted; inspect the audit result.'
                : execution
                  ? 'Market order confirmed. Review the final execution outcome.'
                  : result.data?.newSessionId && result.data?.previousSessionId
                    ? `New session ${String(result.data.newSessionId).slice(0, 8)} is ready and paused. The previous session is archived; starting allocations were issued once.`
                    : 'Command confirmed.',
          bad: result.status === 'REJECTED' || result.data?.ok === false,
        });
        try {
          await workspace.refresh();
        } catch {
          /* The connection banner owns refresh failures. */
        }
      }
      return result;
    },
    [workspace.refresh],
  );
  const recoverCommand = useCallback(
    async (retry: boolean) => {
      const path = runner.pending?.path;
      const result = await (retry ? runner.retry() : runner.resolve());
      await notifyResult(result);
      if (
        result?.status === 'ACCEPTED' &&
        (path === '/api/admin/invitations' || path?.endsWith('/recovery'))
      ) {
        if (result.token) setHandoff({ token: result.token, recovery: path.endsWith('/recovery') });
        else
          setNotice({
            message:
              'The link was issued, but its one-time secret cannot be retrieved from a receipt. Revoke and reissue the invitation, or issue a new recovery link.',
            bad: true,
          });
      }
    },
    [runner, notifyResult],
  );
  const resolve = useCallback(() => recoverCommand(false), [recoverCommand]);
  useEffect(() => {
    if (runner.pending) void resolve();
  }, [runner, resolve]);
  async function runCommand(path: string, body: Record<string, unknown>, label: string) {
    if (
      !workspace.data ||
      !connected ||
      (workspace.data.rollover && path !== '/api/admin/sessions/rollover')
    ) {
      setNotice({
        message: 'Wait for a live, refreshed workspace before submitting a command.',
        bad: true,
      });
      return null;
    }
    setNotice(null);
    return notifyResult(await runner.submit(path, body, label, workspace.data.sessionId));
  }
  async function logout() {
    setSigningOut(true);
    try {
      await api('/api/auth/logout', {}, undefined, user.accountId);
      onUnauthorized();
    } catch (error) {
      setNotice({ message: errorMessage(error), bad: true });
    } finally {
      setSigningOut(false);
    }
  }
  const data = workspace.data;
  const sessionSeen = useRef<string | null>(null);
  const [sessionChange, setSessionChange] = useState<{ previous: string; current: string } | null>(
    null,
  );
  useEffect(() => {
    if (!data) return;
    if (sessionSeen.current && sessionSeen.current !== data.sessionId) {
      setSessionChange({ previous: sessionSeen.current, current: data.sessionId });
    }
    sessionSeen.current = data.sessionId;
  }, [data?.sessionId]);
  const busy =
    Boolean(data?.rollover) ||
    runner.busy ||
    Boolean(runner.pending) ||
    Boolean(runner.error) ||
    signingOut;
  void version; // Runner notifications render its durable state without copying it into another store.

  return (
    <div className="application">
      <a className="skip-link" href="#workspace-content">
        Skip to workspace
      </a>
      <header className="app-header">
        <NavLink to={user.role === 'ADMIN' ? '/admin' : '/trade'} className="brand">
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          <span>
            exchange<span className="brand-sub">sandbox</span>
          </span>
        </NavLink>
        <nav className="main-nav" aria-label="Workspace navigation">
          {user.role === 'ADMIN' ? (
            <NavLink to="/admin">
              <LayoutDashboard size={16} />
              Administration
            </NavLink>
          ) : (
            <>
              <NavLink to="/trade">
                <Activity size={16} />
                Trade
              </NavLink>
              <NavLink to="/orders">
                <ListOrdered size={16} />
                Orders
              </NavLink>
              <NavLink to="/balances">
                <Wallet size={16} />
                Balances
              </NavLink>
              <NavLink to="/history">
                <History size={16} />
                History
              </NavLink>
            </>
          )}
        </nav>
        <div className="header-actions">
          <span className="sim-pill">SIMULATION</span>
          <button className="icon-button" aria-label="Trading rules" onClick={() => setRules(true)}>
            <CircleHelp size={18} />
          </button>
          <button
            className="account-button"
            aria-label={`Account settings for ${user.handle}`}
            onClick={() => setSettings(true)}
          >
            <span className="avatar">{user.handle.slice(0, 1).toUpperCase()}</span>
            <span>
              {user.handle}
              <small>{user.role === 'ADMIN' ? 'Administrator' : 'Trader'}</small>
            </span>
          </button>
          <button
            className="icon-button"
            aria-label="Sign out"
            onClick={() => void logout()}
            disabled={signingOut}
          >
            <LogOut size={17} />
          </button>
        </div>
      </header>
      <div className="connection-strip">
        <div
          className={`connection-label ${connected ? 'connected' : 'disconnected'}`}
          role="status"
        >
          {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
          {connected
            ? 'Live · synced'
            : workspace.connection === 'offline'
              ? 'Offline · submissions disabled'
              : 'Connecting · submissions disabled'}
        </div>
        <span className="session-label">
          {data ? (
            <>
              SESSION <span className="mono">{data.sessionId.slice(0, 8)}</span>
              <span className={`market-status ${data.marketState === 'TRADING' ? 'trading' : ''}`}>
                {data.fault ? 'ACCOUNTING HALT' : data.marketState}
              </span>
            </>
          ) : (
            'Loading active session'
          )}
        </span>
        <button
          className="quiet-button"
          disabled={workspace.isFetching}
          onClick={() => void workspace.refresh().catch(() => undefined)}
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>
      <main className="app-main" id="workspace-content">
        {data?.rollover && (
          <div className="notice warning rollover-progress" role="status">
            <strong>Session rollover in progress.</strong> Existing orders are being canceled and
            final records preserved. New trading and funding are temporarily disabled. Operation{' '}
            <span className="mono">{data.rollover.operationId.slice(0, 8)}</span> resumes safely
            after a restart.
          </div>
        )}
        {sessionChange && (
          <div className="notice success session-change-banner" role="status">
            <strong>A new trading session is ready.</strong> Session{' '}
            <span className="mono">{sessionChange.previous.slice(0, 8)}</span> is archived. Session{' '}
            <span className="mono">{sessionChange.current.slice(0, 8)}</span> starts paused with
            fresh allocations. Review the new session before submitting; previous forms and previews
            have been cleared.{' '}
            <button className="quiet-button" onClick={() => setSessionChange(null)}>
              Dismiss session change
            </button>
          </div>
        )}
        {data?.fault && (
          <div className="notice danger" role="alert">
            <strong>Trading is halted for an accounting check.</strong> Funds cannot move until the
            administrator completes reconciliation. Reads remain available.
          </div>
        )}
        {!connected && data && (
          <div className="notice warning" role="status">
            This is the last confirmed snapshot. Reconnecting restores balances and orders before
            new submissions are enabled.
          </div>
        )}
        {runner.pending && (
          <div className="notice warning pending-command" role="status">
            <div>
              <strong>{runner.busy ? 'Resolving command…' : 'Command outcome unknown'}</strong>
              <p>
                {runner.pending.label} · session{' '}
                <span className="mono">{runner.pending.body.sessionId.slice(0, 8)}</span> ·{' '}
                <span className="mono">{runner.pending.body.commandId.slice(0, 8)}</span>.{' '}
                {runner.error ??
                  'Waiting for a committed response. Refreshing this page keeps the original request identity.'}
              </p>
            </div>
            <div className="button-row">
              <button
                className="button"
                disabled={runner.busy || !connected}
                onClick={() => void resolve()}
              >
                Resolve outcome
              </button>
              <button
                className="button"
                disabled={runner.busy || !connected}
                onClick={() => void recoverCommand(true)}
              >
                Retry same command
              </button>
            </div>
          </div>
        )}
        {runner.error && !runner.pending && (
          <div className="notice danger" role="alert">
            {runner.error}
            {!runner.storageBlocked && (
              <button className="quiet-button" onClick={() => runner.dismissError()}>
                Dismiss
              </button>
            )}
          </div>
        )}
        {notice && (
          <div className={`notice ${notice.bad ? 'danger' : 'success'}`} role="status">
            {notice.message}
            <button className="quiet-button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}
        {!data ? (
          <LoadingView
            message={
              workspace.error
                ? 'Waiting for the exchange to reconnect…'
                : 'Loading a committed workspace…'
            }
          />
        ) : (
          <Suspense fallback={<LoadingView message="Loading your workspace…" />}>
            <Routes>
              {user.role === 'ADMIN' ? (
                <Route
                  path="/admin"
                  element={
                    <AdminWorkspace
                      key={data.sessionId}
                      workspace={data}
                      readOrder={readOrder}
                      connected={connected}
                      busy={busy}
                      runCommand={runCommand}
                      refresh={workspace.refresh}
                      readAccount={readAccount}
                    />
                  }
                />
              ) : (
                ['trade', 'orders', 'balances', 'history'].map((section) => (
                  <Route
                    key={section}
                    path={`/${section}`}
                    element={
                      section === 'history' ? (
                        <SessionHistory
                          workspace={data}
                          readOrder={readOrder}
                          readAccount={readAccount}
                        />
                      ) : (
                        <TraderWorkspace
                          key={data.sessionId}
                          workspace={data}
                          section={section as 'trade' | 'orders' | 'balances'}
                          connected={connected}
                          busy={busy}
                          runCommand={runCommand}
                          refresh={workspace.refresh}
                          readOrder={readOrder}
                          previewMarket={previewMarket}
                        />
                      )
                    }
                  />
                ))
              )}
              <Route
                path="*"
                element={<Navigate to={user.role === 'ADMIN' ? '/admin' : '/trade'} replace />}
              />
            </Routes>
          </Suspense>
        )}
      </main>
      <footer className="app-footer">
        <span>
          <ShieldLabel /> Virtual assets only. No monetary value.
        </span>
        <button className="quiet-button" onClick={() => setRules(true)}>
          Market rules <ArrowUpRight size={12} />
        </button>
      </footer>
      <PasswordDialog
        open={settings}
        onOpenChange={setSettings}
        handle={user.handle}
        actorId={user.accountId}
        onChanged={() => {
          setNotice({ message: 'Password changed. Other sessions were revoked.', bad: false });
        }}
      />
      {marketOutcome && (
        <Suspense fallback={<LoadingView message="Loading the confirmed market outcome…" />}>
          <MarketOutcomeDialog outcome={marketOutcome} close={() => setMarketOutcome(null)} />
        </Suspense>
      )}
      <Dialog
        open={Boolean(handoff)}
        onOpenChange={(open) => {
          if (!open) setHandoff(null);
        }}
        title="Recovered handoff link"
        description="This secret appears only once. Copy it before closing; it is never stored in browser request recovery."
      >
        {handoff && (
          <label className="field">
            {handoff.recovery ? 'Recovery' : 'Invitation'} link
            <input
              readOnly
              value={`${location.origin}/${handoff.recovery ? 'recover' : 'join'}#token=${encodeURIComponent(handoff.token)}`}
              onFocus={(event) => event.target.select()}
            />
          </label>
        )}
        <p className="muted">Share this single-use link privately with the intended participant.</p>
      </Dialog>
      <Dialog
        open={rules}
        onOpenChange={setRules}
        title="A market built for learning"
        description="Every order matches only against another participant in this installation."
      >
        <dl className="rule-list">
          <dt>Pair</dt>
          <dd>BTC-SIM / USD-SIM</dd>
          <dt>Order types</dt>
          <dd>Limit · good until canceled. Protected market · immediate or cancel.</dd>
          <dt>Market protection</dt>
          <dd>
            Fixed 5% guard from the preview reference. Preview expires after 10 seconds; unfilled
            quantity is canceled.
          </dd>
          <dt>Priority</dt>
          <dd>Best price, then acceptance sequence</dd>
          <dt>Execution price</dt>
          <dd>The resting order’s price</dd>
          <dt>Fee</dt>
          <dd>0.1% per side, paid in USD-SIM</dd>
          <dt>Precision</dt>
          <dd>Quantity 0.0001 BTC-SIM · price 0.01 USD-SIM</dd>
          <dt>Minimum order</dt>
          <dd>1 USD-SIM notional</dd>
          <dt>Account limits</dt>
          <dd>50 open orders · 100 BTC-SIM per order</dd>
        </dl>
        <p className="muted">
          No borrowing, external prices, deposits, or withdrawals. Self-trade prevention cancels the
          incoming remainder. Signing out leaves open orders active.
        </p>
      </Dialog>
    </div>
  );
}

function ShieldLabel() {
  return <span className="status-dot" />;
}

function PasswordDialog({
  open,
  onOpenChange,
  handle,
  actorId,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  handle: string;
  actorId: string;
  onChanged: () => void;
}) {
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) {
      setCurrent('');
      setNew('');
      setConfirmation('');
      setError('');
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
      title="Account settings"
      description={`Signed in as ${handle}. Changing your password revokes other sessions and keeps this browser signed in.`}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (newPassword !== confirmation) {
            setError('The passwords do not match.');
            return;
          }
          setBusy(true);
          setError('');
          void api('/api/auth/password', { currentPassword, newPassword }, undefined, actorId)
            .then(() => {
              onOpenChange(false);
              onChanged();
            })
            .catch((error) => setError(errorMessage(error)))
            .finally(() => setBusy(false));
        }}
      >
        <label className="field">
          Current password
          <input
            type="password"
            autoComplete="current-password"
            required
            value={currentPassword}
            onChange={(event) => setCurrent(event.target.value)}
          />
        </label>
        <label className="field">
          New password
          <input
            type="password"
            autoComplete="new-password"
            required
            minLength={12}
            maxLength={128}
            value={newPassword}
            onChange={(event) => setNew(event.target.value)}
          />
        </label>
        <label className="field">
          Confirm new password
          <input
            type="password"
            autoComplete="new-password"
            required
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error && (
          <p className="notice danger" role="alert">
            {error}
          </p>
        )}
        <button className="button primary" disabled={busy}>
          <KeyRound size={15} />
          {busy ? 'Updating…' : 'Change password'}
        </button>
      </form>
    </Dialog>
  );
}
