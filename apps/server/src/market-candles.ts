import { sql, type RawBuilder } from 'kysely';

export interface MarketCandleRow {
  timestamp: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

/** Latest populated minutes, with every fill in each selected minute included. */
export function marketCandleQuery(sessionId: string): RawBuilder<MarketCandleRow> {
  return sql<MarketCandleRow>`
    WITH RECURSIVE minutes(bucket, position) AS (
      (SELECT date_trunc('minute', created_at AT TIME ZONE 'UTC'), 1
        FROM fills WHERE session_id = ${sessionId}::uuid
        ORDER BY date_trunc('minute', created_at AT TIME ZONE 'UTC') DESC LIMIT 1)
      UNION ALL
      SELECT older.bucket, minutes.position + 1 FROM minutes
        CROSS JOIN LATERAL (
          SELECT date_trunc('minute', created_at AT TIME ZONE 'UTC') AS bucket
          FROM fills WHERE session_id = ${sessionId}::uuid
            AND date_trunc('minute', created_at AT TIME ZONE 'UTC') < minutes.bucket
          ORDER BY date_trunc('minute', created_at AT TIME ZONE 'UTC') DESC LIMIT 1
        ) older WHERE minutes.position < 60
    ), totals AS (
      SELECT date_trunc('minute', created_at AT TIME ZONE 'UTC') AS bucket,
        max(price)::text AS high, min(price)::text AS low, sum(quantity)::text AS volume
      FROM fills WHERE session_id = ${sessionId}::uuid
        AND date_trunc('minute', created_at AT TIME ZONE 'UTC') >=
          (SELECT min(bucket) FROM minutes)
      GROUP BY date_trunc('minute', created_at AT TIME ZONE 'UTC')
    )
    SELECT totals.bucket AT TIME ZONE 'UTC' AS timestamp,
      first_fill.price::text AS open, totals.high, totals.low,
      last_fill.price::text AS close, totals.volume
    FROM totals
      CROSS JOIN LATERAL (
        SELECT price FROM fills WHERE session_id = ${sessionId}::uuid
          AND date_trunc('minute', created_at AT TIME ZONE 'UTC') = totals.bucket
        ORDER BY sequence, fill_index LIMIT 1
      ) first_fill
      CROSS JOIN LATERAL (
        SELECT price FROM fills WHERE session_id = ${sessionId}::uuid
          AND date_trunc('minute', created_at AT TIME ZONE 'UTC') = totals.bucket
        ORDER BY sequence DESC, fill_index DESC LIMIT 1
      ) last_fill
    ORDER BY totals.bucket DESC`;
}
