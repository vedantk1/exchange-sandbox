import type { ColumnType, Generated, GeneratedAlways } from 'kysely';

/** PostgreSQL numeric/int8 values stay strings until the domain parses them. */
export type ExactInteger = ColumnType<string, string, string>;
type DefaultExactInteger = ColumnType<string, string | undefined, string>;
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type JsonObject = ColumnType<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>
>;

export type Asset = 'BTC-SIM' | 'USD-SIM';
export type Bucket = 'AVAILABLE' | 'RESERVED';

export interface Database {
  demo_market: {
    session_id: string;
    maker_account_id: string;
    taker_account_id: string;
    enabled: boolean;
    status: 'RUNNING' | 'STOPPED' | 'STOPPING' | 'LIMITED_INVENTORY' | 'ERROR';
    generation: DefaultExactInteger;
    cycle: DefaultExactInteger;
    reference_price: DefaultExactInteger;
    plan: ColumnType<unknown[], string, string>;
    next_command: Generated<number>;
    updated_at: Timestamp;
  };
  exchange_sessions: {
    id: string;
    state: 'ACTIVE' | 'CLOSED';
    created_at: Timestamp;
  };
  exchange_control: {
    id: number;
    active_session_id: string | null;
    next_sequence: DefaultExactInteger;
    writer_epoch: DefaultExactInteger;
    fault: string | null;
    market_state: Generated<'TRADING' | 'PAUSED'>;
  };
  accounts: {
    id: string;
    kind: 'TRADER' | 'ADMIN' | 'FEE' | 'ISSUANCE';
    label: string;
    created_at: Timestamp;
  };
  balances: {
    session_id: string;
    account_id: string;
    asset: Asset;
    bucket: Bucket;
    amount: ExactInteger;
  };
  allocations: {
    session_id: string;
    account_id: string;
    command_id: string;
  };
  orders: {
    id: string;
    session_id: string;
    account_id: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET';
    status: 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED';
    quantity: ExactInteger;
    remaining_quantity: ExactInteger;
    price: ExactInteger;
    acceptance_sequence: ExactInteger;
    reserved_amount: ExactInteger;
    cancel_reason: string | null;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  fills: {
    id: string;
    session_id: string;
    maker_order_id: string;
    taker_order_id: string;
    buy_order_id: string;
    sell_order_id: string;
    quantity: ExactInteger;
    price: ExactInteger;
    notional: ExactInteger;
    buyer_fee: ExactInteger;
    seller_fee: ExactInteger;
    sequence: ExactInteger;
    fill_index: number;
    created_at: Timestamp;
  };
  journal_transactions: {
    id: string;
    session_id: string;
    command_id: string;
    kind: string;
    created_at: Timestamp;
    created_xid: GeneratedAlways<string>;
  };
  journal_entries: {
    id: GeneratedAlways<string>;
    journal_transaction_id: string;
    session_id: string;
    account_id: string;
    asset: Asset;
    bucket: Bucket;
    amount: ExactInteger;
  };
  receipts: {
    actor_id: string;
    command_id: string;
    session_id: string;
    payload_hash: string;
    result: JsonObject;
    sequence: ExactInteger;
    created_at: Timestamp;
  };
  outbox: {
    id: GeneratedAlways<string>;
    session_id: string;
    sequence: ExactInteger;
    event_type: string;
    payload: JsonObject;
    created_at: Timestamp;
  };
  schema_migrations: {
    name: string;
    applied_at: Timestamp;
  };
  users: {
    account_id: string;
    role: 'ADMIN' | 'TRADER';
    handle: string;
    password_hash: string;
    status: Generated<'ACTIVE' | 'SUSPENDED'>;
    suspension_reason: string | null;
    pending_cancellation: Generated<boolean>;
    created_at: Timestamp;
    updated_at: Timestamp;
  };
  login_sessions: {
    token_hash: string;
    account_id: string;
    csrf_hash: string;
    expires_at: Timestamp;
    revoked_at: Date | null;
    created_at: Timestamp;
  };
  invitations: {
    id: string;
    token_hash: string;
    created_by: string;
    expires_at: Timestamp;
    revoked_at: Date | null;
    redeemed_at: Date | null;
    redeemed_by: string | null;
    created_at: Timestamp;
  };
  recovery_tokens: {
    id: string;
    token_hash: string;
    account_id: string;
    created_by: string;
    expires_at: Timestamp;
    used_at: Date | null;
    revoked_at: Date | null;
    created_at: Timestamp;
  };
  admin_audit: {
    id: string;
    actor_id: string;
    command_id: string;
    session_id: string | null;
    action: string;
    target_id: string | null;
    reason: string;
    result: JsonObject;
    created_at: Timestamp;
  };
  grants: {
    id: string;
    session_id: string;
    account_id: string;
    actor_id: string;
    command_id: string;
    asset: Asset;
    amount: ExactInteger;
    reason: string;
    created_at: Timestamp;
  };
}
