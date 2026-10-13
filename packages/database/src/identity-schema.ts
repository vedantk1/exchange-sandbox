/** Identity and administrator controls extend the immutable milestone-one migration. */
export const IDENTITY_SCHEMA = `
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('TRADER', 'ADMIN', 'FEE', 'ISSUANCE'));
ALTER TABLE accounts ADD CONSTRAINT account_role_identity UNIQUE (id, kind);
CREATE UNIQUE INDEX one_administrator_account ON accounts (kind) WHERE kind = 'ADMIN';

CREATE TABLE users (
  account_id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('ADMIN', 'TRADER')),
  handle text NOT NULL UNIQUE CHECK (handle ~ '^[a-z][a-z0-9_]{2,31}$'),
  password_hash text NOT NULL CHECK (length(password_hash) BETWEEN 1 AND 512),
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  suspension_reason text,
  pending_cancellation boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id, role) REFERENCES accounts (id, kind),
  CHECK (role <> 'ADMIN' OR (status = 'ACTIVE' AND NOT pending_cancellation)),
  CHECK (NOT pending_cancellation OR status = 'SUSPENDED')
);
CREATE UNIQUE INDEX one_administrator_identity ON users (role) WHERE role = 'ADMIN';

CREATE TABLE login_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES users (account_id),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);
CREATE INDEX login_sessions_account ON login_sessions (account_id);

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid NOT NULL REFERENCES users (account_id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by uuid REFERENCES users (account_id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at),
  CHECK ((redeemed_at IS NULL) = (redeemed_by IS NULL))
);

CREATE TABLE recovery_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid NOT NULL REFERENCES users (account_id),
  created_by uuid NOT NULL REFERENCES users (account_id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (expires_at > created_at)
);
CREATE INDEX recovery_tokens_account ON recovery_tokens (account_id);

CREATE TABLE admin_audit (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES accounts (id),
  command_id uuid NOT NULL,
  session_id uuid REFERENCES exchange_sessions (id),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 80),
  target_id uuid,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX admin_audit_session ON admin_audit (session_id, created_at, id);
CREATE TRIGGER immutable_admin_audit BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE grants (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  account_id uuid NOT NULL REFERENCES users (account_id),
  actor_id uuid NOT NULL REFERENCES users (account_id),
  command_id uuid NOT NULL,
  asset text NOT NULL CHECK (asset IN ('BTC-SIM', 'USD-SIM')),
  amount numeric(38, 0) NOT NULL CHECK (amount > 0 AND amount <> 'NaN'::numeric
    AND amount <= CASE WHEN asset = 'BTC-SIM' THEN 1000000 ELSE 10000000000000000 END),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_id, command_id)
);
CREATE INDEX grants_account ON grants (session_id, account_id);
CREATE TRIGGER immutable_grants BEFORE UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION reject_administrator_funding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND kind = 'ADMIN') THEN
    RAISE EXCEPTION 'Administrator identities cannot hold funds or trade' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER no_admin_balances BEFORE INSERT OR UPDATE ON balances
  FOR EACH ROW EXECUTE FUNCTION reject_administrator_funding();
CREATE TRIGGER no_admin_orders BEFORE INSERT OR UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION reject_administrator_funding();
CREATE TRIGGER no_admin_allocations BEFORE INSERT ON allocations
  FOR EACH ROW EXECUTE FUNCTION reject_administrator_funding();
CREATE TRIGGER no_admin_grants BEFORE INSERT ON grants
  FOR EACH ROW EXECUTE FUNCTION reject_administrator_funding();
CREATE TRIGGER no_admin_journal BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_administrator_funding();
`;
