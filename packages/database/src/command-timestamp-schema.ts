/** Command evidence records admission time, after waiting for the serialized writer. */
export const COMMAND_TIMESTAMP_SCHEMA = `
CREATE FUNCTION exchange_command_timestamp() RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('sandbox.command_timestamp', true), '')::timestamptz,
    clock_timestamp()
  );
$$;

ALTER TABLE exchange_sessions ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE accounts ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE orders ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE orders ALTER COLUMN updated_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE fills ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE journal_transactions ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE receipts ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE outbox ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE users ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE users ALTER COLUMN updated_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE login_sessions ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE invitations ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE recovery_tokens ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE admin_audit ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE grants ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE demo_market ALTER COLUMN updated_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE market_preview_uses ALTER COLUMN created_at SET DEFAULT exchange_command_timestamp();
ALTER TABLE session_rollovers ALTER COLUMN started_at SET DEFAULT exchange_command_timestamp();
`;
