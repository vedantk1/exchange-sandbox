/** Durable simulator intent; executions and money still belong to the exchange core. */
export const DEMO_MARKET_SCHEMA = `
CREATE TABLE demo_market (
  session_id uuid PRIMARY KEY REFERENCES exchange_sessions (id),
  maker_account_id uuid NOT NULL REFERENCES accounts (id),
  taker_account_id uuid NOT NULL REFERENCES accounts (id),
  enabled boolean NOT NULL DEFAULT false,
  status text NOT NULL CHECK (status IN ('RUNNING', 'STOPPED', 'LIMITED_INVENTORY', 'ERROR')),
  cycle bigint NOT NULL DEFAULT 0 CHECK (cycle >= 0),
  reference_price bigint NOT NULL DEFAULT 5000000 CHECK (reference_price BETWEEN 4800000 AND 5200000),
  plan jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(plan) = 'array'),
  next_command integer NOT NULL DEFAULT 0 CHECK (next_command >= 0 AND next_command <= jsonb_array_length(plan)),
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (maker_account_id <> taker_account_id)
);
`;
