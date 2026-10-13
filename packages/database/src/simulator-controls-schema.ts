/** Extend existing simulator state without changing allocations or execution history. */
export const SIMULATOR_CONTROLS_SCHEMA = `
ALTER TABLE demo_market ADD COLUMN generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0);
ALTER TABLE demo_market DROP CONSTRAINT demo_market_status_check;
ALTER TABLE demo_market ADD CONSTRAINT demo_market_status_check
  CHECK (status IN ('RUNNING', 'STOPPED', 'STOPPING', 'LIMITED_INVENTORY', 'ERROR'));

ALTER TABLE grants DROP CONSTRAINT grants_account_id_fkey;
ALTER TABLE grants ADD CONSTRAINT grants_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts (id);

CREATE FUNCTION validate_grant_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND kind = 'TRADER')
     OR NOT (
       EXISTS (SELECT 1 FROM users WHERE account_id = NEW.account_id AND role = 'TRADER')
       OR EXISTS (SELECT 1 FROM demo_market WHERE session_id = NEW.session_id
         AND NEW.account_id IN (maker_account_id, taker_account_id))
     ) THEN
    RAISE EXCEPTION 'Grant recipient must be an enrolled trader or registered simulator account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER valid_grant_recipient BEFORE INSERT ON grants
  FOR EACH ROW EXECUTE FUNCTION validate_grant_recipient();
`;
