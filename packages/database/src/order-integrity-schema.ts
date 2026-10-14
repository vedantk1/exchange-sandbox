/** Accepted order identity/terms survive settlement, cancellation, and recovery. */
export const ORDER_INTEGRITY_SCHEMA = `
CREATE FUNCTION protect_order_terms() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'Orders cannot be deleted or truncated' USING ERRCODE = '23514';
  END IF;
  IF (NEW.id, NEW.session_id, NEW.account_id, NEW.side, NEW.type,
      NEW.quantity, NEW.price, NEW.acceptance_sequence, NEW.created_at) IS DISTINCT FROM
     (OLD.id, OLD.session_id, OLD.account_id, OLD.side, OLD.type,
      OLD.quantity, OLD.price, OLD.acceptance_sequence, OLD.created_at) THEN
    RAISE EXCEPTION 'Accepted order identity and terms are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER immutable_order_terms BEFORE UPDATE OR DELETE ON orders
  FOR EACH ROW EXECUTE FUNCTION protect_order_terms();
CREATE TRIGGER immutable_order_truncate BEFORE TRUNCATE ON orders
  FOR EACH STATEMENT EXECUTE FUNCTION protect_order_terms();
`;
