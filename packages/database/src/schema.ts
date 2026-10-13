/** The first reviewed schema. Never edit after a published release; add a migration. */
export const INITIAL_SCHEMA = `
CREATE TABLE exchange_sessions (
  id uuid PRIMARY KEY,
  state text NOT NULL CHECK (state IN ('ACTIVE', 'CLOSED')),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX one_active_session ON exchange_sessions (state) WHERE state = 'ACTIVE';

CREATE TABLE exchange_control (
  id integer PRIMARY KEY CHECK (id = 1),
  active_session_id uuid REFERENCES exchange_sessions (id),
  next_sequence bigint NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  writer_epoch bigint NOT NULL DEFAULT 0 CHECK (writer_epoch >= 0),
  fault text,
  market_state text NOT NULL DEFAULT 'PAUSED' CHECK (market_state IN ('TRADING', 'PAUSED'))
);
INSERT INTO exchange_control (id) VALUES (1);

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('TRADER', 'FEE', 'ISSUANCE')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX one_system_account_per_kind ON accounts (kind) WHERE kind IN ('FEE', 'ISSUANCE');

CREATE TABLE balances (
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  asset text NOT NULL CHECK (asset IN ('BTC-SIM', 'USD-SIM')),
  bucket text NOT NULL CHECK (bucket IN ('AVAILABLE', 'RESERVED')),
  amount numeric(38, 0) NOT NULL CHECK (amount <> 'NaN'::numeric),
  PRIMARY KEY (session_id, account_id, asset, bucket)
);

CREATE TABLE allocations (
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  command_id uuid NOT NULL,
  PRIMARY KEY (session_id, account_id)
);

CREATE TABLE orders (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  side text NOT NULL CHECK (side IN ('BUY', 'SELL')),
  type text NOT NULL CHECK (type IN ('LIMIT', 'MARKET')),
  status text NOT NULL CHECK (status IN ('OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED')),
  quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND quantity <= 1000000),
  remaining_quantity numeric(38, 0) NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= quantity AND remaining_quantity <> 'NaN'::numeric),
  price numeric(38, 0) NOT NULL CHECK (price > 0 AND price <= 10000000000),
  acceptance_sequence bigint NOT NULL CHECK (acceptance_sequence > 0),
  reserved_amount numeric(38, 0) NOT NULL CHECK (reserved_amount >= 0 AND reserved_amount <> 'NaN'::numeric),
  cancel_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (id, session_id),
  UNIQUE (session_id, acceptance_sequence),
  CHECK (
    (status = 'OPEN' AND remaining_quantity = quantity) OR
    (status = 'PARTIALLY_FILLED' AND remaining_quantity > 0 AND remaining_quantity < quantity) OR
    (status = 'FILLED' AND remaining_quantity = 0) OR
    (status = 'CANCELED' AND remaining_quantity > 0)
  ),
  CHECK (reserved_amount = CASE
    WHEN status IN ('FILLED', 'CANCELED') THEN 0
    WHEN side = 'BUY' THEN remaining_quantity * price * 1001
    ELSE remaining_quantity
  END)
);
CREATE INDEX sell_book ON orders (session_id, price ASC, acceptance_sequence ASC)
  WHERE side = 'SELL' AND status IN ('OPEN', 'PARTIALLY_FILLED');
CREATE INDEX buy_book ON orders (session_id, price DESC, acceptance_sequence ASC)
  WHERE side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED');
CREATE INDEX account_orders ON orders (session_id, account_id, acceptance_sequence);

CREATE TABLE fills (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  maker_order_id uuid NOT NULL,
  taker_order_id uuid NOT NULL,
  buy_order_id uuid NOT NULL,
  sell_order_id uuid NOT NULL,
  quantity numeric(38, 0) NOT NULL CHECK (quantity > 0 AND quantity <> 'NaN'::numeric),
  price numeric(38, 0) NOT NULL CHECK (price > 0 AND price <> 'NaN'::numeric),
  notional numeric(38, 0) NOT NULL CHECK (notional = quantity * price * 1000),
  buyer_fee numeric(38, 0) NOT NULL CHECK (buyer_fee = quantity * price),
  seller_fee numeric(38, 0) NOT NULL CHECK (seller_fee = quantity * price),
  sequence bigint NOT NULL CHECK (sequence > 0),
  fill_index integer NOT NULL CHECK (fill_index >= 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (session_id, sequence, fill_index),
  CHECK (maker_order_id <> taker_order_id AND buy_order_id <> sell_order_id),
  CHECK (
    (maker_order_id = buy_order_id AND taker_order_id = sell_order_id) OR
    (maker_order_id = sell_order_id AND taker_order_id = buy_order_id)
  ),
  FOREIGN KEY (maker_order_id, session_id) REFERENCES orders (id, session_id),
  FOREIGN KEY (taker_order_id, session_id) REFERENCES orders (id, session_id),
  FOREIGN KEY (buy_order_id, session_id) REFERENCES orders (id, session_id),
  FOREIGN KEY (sell_order_id, session_id) REFERENCES orders (id, session_id)
);
CREATE INDEX session_fills ON fills (session_id, sequence);

CREATE TABLE journal_transactions (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  command_id uuid NOT NULL,
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 80),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  UNIQUE (id, session_id)
);

CREATE TABLE journal_entries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_transaction_id uuid NOT NULL,
  session_id uuid NOT NULL,
  account_id uuid NOT NULL REFERENCES accounts (id),
  asset text NOT NULL CHECK (asset IN ('BTC-SIM', 'USD-SIM')),
  bucket text NOT NULL CHECK (bucket IN ('AVAILABLE', 'RESERVED')),
  amount numeric(38, 0) NOT NULL CHECK (amount <> 0 AND amount <> 'NaN'::numeric),
  FOREIGN KEY (journal_transaction_id, session_id) REFERENCES journal_transactions (id, session_id)
);
CREATE INDEX journal_by_transaction ON journal_entries (journal_transaction_id, asset);
CREATE INDEX journal_by_balance ON journal_entries (session_id, account_id, asset, bucket);

CREATE TABLE receipts (
  actor_id uuid NOT NULL REFERENCES accounts (id),
  command_id uuid NOT NULL,
  session_id uuid NOT NULL,
  payload_hash text NOT NULL CHECK (length(payload_hash) = 64),
  result jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  sequence bigint NOT NULL CHECK (sequence > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (actor_id, command_id)
);

CREATE TABLE outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id uuid NOT NULL,
  sequence bigint NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL CHECK (length(event_type) BETWEEN 1 AND 80),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX outbox_session_cursor ON outbox (session_id, id);

CREATE FUNCTION reject_immutable_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER immutable_journal_transactions BEFORE UPDATE OR DELETE ON journal_transactions
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_journal_entries BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_fills BEFORE UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_receipts BEFORE UPDATE OR DELETE ON receipts
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_outbox BEFORE UPDATE OR DELETE ON outbox
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_allocations BEFORE UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION validate_new_journal_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  header_xid xid8;
BEGIN
  SELECT created_xid INTO header_xid FROM journal_transactions
    WHERE id = NEW.journal_transaction_id;
  IF header_xid IS DISTINCT FROM pg_current_xact_id() THEN
    RAISE EXCEPTION 'Cannot append to an already committed journal transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER journal_entry_transaction_boundary BEFORE INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION validate_new_journal_entry();

CREATE FUNCTION validate_journal_balance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM journal_entries WHERE journal_transaction_id = NEW.id) THEN
    RAISE EXCEPTION 'Journal transaction must contain entries' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT asset FROM journal_entries WHERE journal_transaction_id = NEW.id
    GROUP BY asset HAVING sum(amount) <> 0
  ) THEN
    RAISE EXCEPTION 'Journal transaction must balance separately for every asset' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER balanced_journal AFTER INSERT ON journal_transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_journal_balance();

CREATE FUNCTION validate_balance_sign() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM balances b JOIN accounts a ON a.id = b.account_id
    WHERE b.session_id = NEW.session_id AND b.account_id = NEW.account_id
      AND b.asset = NEW.asset AND b.bucket = NEW.bucket AND b.amount < 0
      AND (b.bucket = 'RESERVED' OR a.kind <> 'ISSUANCE')
  ) THEN
    RAISE EXCEPTION 'Spendable and reserved balances cannot be negative' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER nonnegative_balances AFTER INSERT OR UPDATE ON balances
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_balance_sign();
`;
