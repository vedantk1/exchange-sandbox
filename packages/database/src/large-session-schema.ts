export const MARKET_CANDLE_INDEX = `CREATE INDEX fills_by_minute ON fills
  (session_id, (date_trunc('minute', created_at AT TIME ZONE 'UTC')), sequence, fill_index)
  INCLUDE (created_at, price, quantity);`;

/** Indexed candle bounds and complete financial history traversal. */
export const LARGE_SESSION_SCHEMA = `
${MARKET_CANDLE_INDEX}
CREATE INDEX buy_order_fills ON fills (buy_order_id, sequence, fill_index);
CREATE INDEX sell_order_fills ON fills (sell_order_id, sequence, fill_index);
CREATE INDEX journal_account_history ON journal_entries (session_id, account_id, id);
CREATE INDEX journal_session_history ON journal_entries (session_id, id);
CREATE INDEX receipts_account_history ON receipts (session_id, actor_id, sequence, command_id);
CREATE INDEX receipts_session_history ON receipts (session_id, sequence, command_id, actor_id);
`;
