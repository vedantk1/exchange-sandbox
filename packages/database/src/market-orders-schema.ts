/** Durable previews bind confirmed protection to one recoverable trading command. */
export const MARKET_ORDERS_SCHEMA = `
CREATE TABLE market_previews (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  reference_price numeric(38, 0) NOT NULL CHECK (reference_price > 0 AND reference_price <= 10000000000),
  guard_price numeric(38, 0) NOT NULL CHECK (guard_price > 0 AND guard_price <= 10000000000),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  UNIQUE (id, account_id, session_id),
  CHECK (expires_at = created_at + interval '10 seconds'),
  CHECK (quantity * guard_price * 1000 >= 1000000000),
  CHECK (guard_price = CASE WHEN side = 'BUY'
    THEN floor(reference_price * 105 / 100)
    ELSE ceil(reference_price * 95 / 100) END)
);
CREATE TRIGGER immutable_market_previews BEFORE UPDATE OR DELETE ON market_previews
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE market_preview_uses (
  preview_id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  session_id uuid NOT NULL,
  command_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (actor_id, command_id),
  FOREIGN KEY (preview_id, actor_id, session_id)
    REFERENCES market_previews (id, account_id, session_id),
  FOREIGN KEY (actor_id, command_id) REFERENCES receipts (actor_id, command_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TRIGGER immutable_market_preview_uses BEFORE UPDATE OR DELETE ON market_preview_uses
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

ALTER TABLE orders ADD CONSTRAINT market_orders_never_rest
  CHECK (type <> 'MARKET' OR (status IN ('FILLED', 'CANCELED') AND reserved_amount = 0));
`;
