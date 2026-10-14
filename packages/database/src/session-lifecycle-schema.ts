/** A durable transition gate and immutable financial archives. */
export const SESSION_LIFECYCLE_SCHEMA = `
ALTER TABLE exchange_sessions ADD COLUMN closed_at timestamptz;
UPDATE exchange_sessions SET closed_at = created_at WHERE state = 'CLOSED';
ALTER TABLE exchange_sessions ADD CONSTRAINT session_close_timestamp
  CHECK ((state = 'ACTIVE' AND closed_at IS NULL) OR (state = 'CLOSED' AND closed_at IS NOT NULL));

CREATE TABLE session_rollovers (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL REFERENCES accounts (id),
  command_id uuid NOT NULL,
  previous_session_id uuid NOT NULL REFERENCES exchange_sessions (id),
  new_session_id uuid NOT NULL UNIQUE,
  payload_hash text NOT NULL,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  state text NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  started_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at timestamptz,
  UNIQUE (actor_id, command_id),
  UNIQUE (previous_session_id),
  CHECK (previous_session_id <> new_session_id),
  CHECK ((state = 'IN_PROGRESS' AND completed_at IS NULL) OR
    (state = 'COMPLETED' AND completed_at IS NOT NULL))
);
ALTER TABLE exchange_control ADD COLUMN rollover_operation_id uuid REFERENCES session_rollovers (id);
ALTER TABLE exchange_control ADD CONSTRAINT rollover_is_paused
  CHECK (rollover_operation_id IS NULL OR market_state = 'PAUSED');

CREATE FUNCTION protect_session_rollover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD.state = 'COMPLETED' OR
    (NEW.id, NEW.actor_id, NEW.command_id, NEW.previous_session_id, NEW.new_session_id,
      NEW.payload_hash, NEW.reason, NEW.started_at) IS DISTINCT FROM
    (OLD.id, OLD.actor_id, OLD.command_id, OLD.previous_session_id, OLD.new_session_id,
      OLD.payload_hash, OLD.reason, OLD.started_at) THEN
    RAISE EXCEPTION 'Session rollover identity and completed outcome are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_rollover BEFORE UPDATE OR DELETE ON session_rollovers
  FOR EACH ROW EXECUTE FUNCTION protect_session_rollover();

CREATE FUNCTION protect_closed_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'Archived sessions cannot be changed or deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.created_at) THEN
    RAISE EXCEPTION 'Session identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_closed_session BEFORE UPDATE OR DELETE ON exchange_sessions
  FOR EACH ROW EXECUTE FUNCTION protect_closed_session();

CREATE FUNCTION require_active_financial_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_session uuid;
BEGIN
  target_session := CASE WHEN TG_OP = 'DELETE' THEN OLD.session_id ELSE NEW.session_id END;
  IF NOT EXISTS (SELECT 1 FROM exchange_sessions WHERE id = target_session AND state = 'ACTIVE') OR
    (TG_OP = 'UPDATE' AND EXISTS (
      SELECT 1 FROM exchange_sessions WHERE id = OLD.session_id AND state = 'CLOSED'
    )) THEN
    RAISE EXCEPTION 'Archived financial history is read only' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER active_balance_session BEFORE INSERT OR UPDATE OR DELETE ON balances
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_order_session BEFORE INSERT OR UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_fill_session BEFORE INSERT OR UPDATE OR DELETE ON fills
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_allocation_session BEFORE INSERT OR UPDATE OR DELETE ON allocations
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_grant_session BEFORE INSERT OR UPDATE OR DELETE ON grants
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_journal_session BEFORE INSERT OR UPDATE OR DELETE ON journal_transactions
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_entry_session BEFORE INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
CREATE TRIGGER active_simulator_session BEFORE INSERT OR UPDATE OR DELETE ON demo_market
  FOR EACH ROW EXECUTE FUNCTION require_active_financial_session();
`;
