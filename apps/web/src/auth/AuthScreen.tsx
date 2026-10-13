import { useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowRight, ArrowUpRight, Layers3, ShieldCheck, KeyRound } from 'lucide-react';
import { api, errorMessage, type User } from '../lib/api.js';

function readToken(): string {
  return new URLSearchParams(location.hash.slice(1)).get('token') ?? '';
}

export function AuthScreen({
  mode,
  onLogin,
}: {
  mode: 'login' | 'join' | 'recover';
  onLogin: (user: User) => void;
}) {
  const [initialToken] = useState(readToken);
  const [token, setToken] = useState(initialToken);
  const [fromLink, setFromLink] = useState(Boolean(initialToken));
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [complete, setComplete] = useState(false);
  const handoffGeneration = useRef(0);
  const navigate = useNavigate();
  const title =
    mode === 'login'
      ? 'Welcome back.'
      : mode === 'join'
        ? 'Your exchange starts here.'
        : 'Restore your access.';

  // Reading is pure: React Strict Mode may invoke state initializers twice.
  // Remove the handoff secret only after React has retained it in memory.
  useLayoutEffect(() => {
    const capture = () => {
      const incoming = readToken();
      if (incoming) {
        handoffGeneration.current += 1;
        setToken(incoming);
        setFromLink(true);
        setComplete(false);
        setError('');
        setPassword('');
        setConfirmation('');
      }
      if (location.hash)
        history.replaceState(history.state, '', location.pathname + location.search);
    };
    capture();
    window.addEventListener('hashchange', capture);
    return () => window.removeEventListener('hashchange', capture);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setError('');
    if (mode !== 'login' && password !== confirmation) {
      setError('The passwords do not match.');
      return;
    }
    setBusy(true);
    const generation = handoffGeneration.current;
    try {
      if (mode === 'login') {
        const result = await api<{ user: User }>('/api/auth/login', { handle, password });
        setPassword('');
        onLogin(result.user);
        navigate(result.user.role === 'ADMIN' ? '/admin' : '/trade', { replace: true });
      } else {
        await api(mode === 'join' ? '/api/auth/redeem' : '/api/auth/recover', {
          token,
          password,
          ...(mode === 'join' ? { handle } : {}),
        });
        if (generation !== handoffGeneration.current) return;
        setPassword('');
        setConfirmation('');
        setToken('');
        setComplete(true);
      }
    } catch (error) {
      if (generation === handoffGeneration.current) setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link className="brand" to="/login">
          <span className="brand-mark">
            <Layers3 size={22} />
          </span>
          <span>
            exchange<span className="brand-sub">sandbox</span>
          </span>
        </Link>
        <div className="auth-story-content">
          <span className="eyebrow">A SMALL EXCHANGE. EVERY DETAIL VISIBLE.</span>
          <h1>
            Understand
            <br />
            every trade.
          </h1>
          <p>
            Place an order. Watch it match. Follow every fill, fee, and balance change in a shared
            exchange built for learning.
          </p>
          <div className="auth-market-illustration" aria-hidden="true">
            <div className="illustration-top">
              <span>BTC-SIM / USD-SIM</span>
              <span className="sim-pill">SIMULATION</span>
            </div>
            <div className="illustration-book">
              <span>PRICE</span>
              <span>QUANTITY</span>
              {[74, 49, 63, 28, 39, 62, 86].map((width, index) => (
                <div
                  className={index < 3 ? 'illustration-ask' : 'illustration-bid'}
                  key={index}
                  style={{ '--bar': `${width}%` } as CSSProperties}
                >
                  <i />
                  <b />
                  <small />
                </div>
              ))}
            </div>
            <div className="illustration-footer">
              <ShieldCheck size={15} /> Virtual assets. Real exchange mechanics.
            </div>
          </div>
        </div>
        <div className="auth-footnote">
          BTC-SIM and USD-SIM have no monetary value.
          <br />
          No deposits, wallets, or external market feeds.
        </div>
      </section>
      <section className="auth-form-side">
        <div className="auth-form-wrap">
          <div className="auth-status">
            <span className="status-dot" /> PRIVATE · INVITATION ONLY
          </div>
          <h2>
            {complete
              ? mode === 'join'
                ? 'You’re ready to explore.'
                : 'Your password is updated.'
              : title}
          </h2>
          <p className="muted">
            {complete
              ? mode === 'join'
                ? 'Your account received 1 BTC-SIM and 100,000 USD-SIM in virtual starting funds. Sign in to inspect the workspace.'
                : 'Previous sessions have been revoked. Sign in with your new password.'
              : mode === 'login'
                ? 'Sign in to your trading or administrator workspace.'
                : mode === 'join'
                  ? 'Redeem your invitation and choose an account handle. All trading stays inside this installation.'
                  : 'Use the single-use recovery link supplied by your administrator.'}
          </p>
          {complete ? (
            <Link className="button primary auth-submit" to="/login">
              Continue to sign in <ArrowRight size={16} />
            </Link>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              {mode !== 'login' && !fromLink && (
                <label className="field">
                  {mode === 'join' ? 'Invitation token' : 'Recovery token'}
                  <input
                    required
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Paste the token from your operator"
                  />
                </label>
              )}
              {mode !== 'recover' && (
                <label className="field">
                  Handle
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z][A-Za-z0-9_]{2,31}"
                    value={handle}
                    onChange={(event) => setHandle(event.target.value)}
                    placeholder="Your handle"
                    autoFocus
                  />
                  {mode === 'join' && (
                    <small>3–32 letters, numbers, or underscores. Start with a letter.</small>
                  )}
                </label>
              )}
              <label className="field">
                {mode === 'recover' ? 'New password' : 'Password'}
                <input
                  type="password"
                  name="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  required
                  minLength={12}
                  maxLength={128}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={mode === 'login' ? 'Enter your password' : 'At least 12 characters'}
                />
              </label>
              {mode !== 'login' && (
                <label className="field">
                  Confirm password
                  <input
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </label>
              )}
              {error && (
                <div className="notice danger" role="alert">
                  {error}
                  {mode !== 'login' && (
                    <p>
                      If the link is expired or already used, contact the operator. If your previous
                      response was lost, try signing in before redeeming again.
                    </p>
                  )}
                </div>
              )}
              <button className="button primary auth-submit" disabled={busy}>
                {busy
                  ? 'Please wait…'
                  : mode === 'login'
                    ? 'Sign in'
                    : mode === 'join'
                      ? 'Create virtual trading account'
                      : 'Update password'}
                <ArrowRight size={16} />
              </button>
            </form>
          )}
          {!complete && (
            <div className="auth-help">
              {mode === 'login' ? (
                <>
                  <p>
                    <KeyRound size={15} /> Need access or a password reset? Ask your operator for a
                    link.
                  </p>
                  <Link to="/join">
                    Redeem an invitation <ArrowUpRight size={14} />
                  </Link>
                </>
              ) : (
                <Link to="/login">
                  Already have access? Sign in <ArrowRight size={14} />
                </Link>
              )}
            </div>
          )}
        </div>
        <div className="auth-bottom">Built to make the mechanics visible.</div>
      </section>
    </main>
  );
}
