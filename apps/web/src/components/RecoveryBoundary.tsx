import { Component, useEffect, useRef, type ReactNode } from 'react';

/** A rejected lazy import stays rejected until reload; remounting it cannot recover the module. */
export class RecoveryBoundary extends Component<{ children: ReactNode }, { interrupted: boolean }> {
  override state = { interrupted: false };

  static getDerivedStateFromError() {
    return { interrupted: true };
  }

  override render() {
    return this.state.interrupted ? <RecoveryScreen /> : this.props.children;
  }
}

function RecoveryScreen() {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className="standalone-error workspace-recovery" aria-labelledby="recovery-heading">
      <h1 id="recovery-heading" ref={heading} tabIndex={-1}>
        Workspace interrupted
      </h1>
      <p>
        A loading or display error interrupted the interface. This can happen after an update or a
        connection interruption.
      </p>
      <p>
        Reloading does not create or resend an order. Any saved request stays tied to the account
        and trading session that submitted it. Its outcome is checked when that account signs in.
      </p>
      <button className="button primary" onClick={() => window.location.reload()}>
        Reload workspace
      </button>
      <p className="muted">
        If this screen returns, check your connection or contact the administrator. Keep this tab
        and its saved requests until any unknown command outcome is resolved.
      </p>
    </main>
  );
}
