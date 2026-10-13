import type { Database } from '@sandbox/database';
import { sql, type Kysely, type RawBuilder, type Transaction } from 'kysely';

type Check = { code: string; query: RawBuilder<{ detail: string }> };
const MAX_ISSUES = 50;

/**
 * Compare independent persisted evidence before admitting another command.
 * The caller must hold exchange_control's row lock throughout this read-only
 * scan, or supply an equally consistent snapshot. SQL failures propagate: an
 * incomplete scan must never become a successful reconciliation report.
 */
export async function reconcileDatabase(
  database: Kysely<Database> | Transaction<Database>,
): Promise<{ ok: boolean; issues: string[] }> {
  const checks: Check[] = [
    {
      code: 'SESSION_CONTROL',
      query: sql`
        select 'Active session and installation control disagree' as detail
        where (select count(*) from exchange_control) <> 1
          or exists (
            select 1 from exchange_control c
            left join exchange_sessions s on s.id = c.active_session_id
            where (c.active_session_id is not null and s.state is distinct from 'ACTIVE')
              or (c.active_session_id is null and exists (select 1 from exchange_sessions))
          )
          or exists (
            select 1 from exchange_sessions s where s.state = 'ACTIVE'
              and not exists (select 1 from exchange_control c where c.active_session_id = s.id)
          )
      `,
    },
    {
      code: 'JOURNAL_BALANCE',
      query: sql`
        select j.id::text || ': ' || coalesce(e.asset, 'empty journal') as detail
        from journal_transactions j
        left join journal_entries e on e.journal_transaction_id = j.id
        group by j.id, e.asset
        having count(e.id) = 0 or sum(e.amount) <> 0
      `,
    },
    {
      code: 'BALANCE_PROJECTION',
      query: sql`
        with journal_totals as (
          select session_id, account_id, asset, bucket, sum(amount) as amount
          from journal_entries group by session_id, account_id, asset, bucket
        )
        select coalesce(b.session_id, j.session_id)::text || '/' ||
          coalesce(b.account_id, j.account_id)::text || '/' ||
          coalesce(b.asset, j.asset) || '/' || coalesce(b.bucket, j.bucket) as detail
        from balances b full outer join journal_totals j
          using (session_id, account_id, asset, bucket)
        where coalesce(b.amount, 0) <> coalesce(j.amount, 0)
      `,
    },
    {
      code: 'BALANCE_SIGN',
      query: sql`
        select b.session_id::text || '/' || b.account_id::text || '/' ||
          b.asset || '/' || b.bucket as detail
        from balances b join accounts a on a.id = b.account_id
        where b.amount = 'NaN'::numeric or
          (b.amount < 0 and (b.bucket = 'RESERVED' or a.kind <> 'ISSUANCE'))
      `,
    },
    {
      code: 'ASSET_CONSERVATION',
      query: sql`
        select session_id::text || '/' || asset as detail from balances
        group by session_id, asset having sum(amount) <> 0
      `,
    },
    {
      code: 'TRADER_TOTAL',
      query: sql`
        with expected_moves as (
          select session_id, account_id, 'BTC-SIM' as asset, 10000::numeric as amount from allocations
          union all
          select session_id, account_id, 'USD-SIM', 100000000000000::numeric from allocations
          union all
          select session_id, account_id, asset, amount from grants
          union all
          select f.session_id, o.account_id, 'BTC-SIM', f.quantity
            from fills f join orders o on o.id = f.buy_order_id
          union all
          select f.session_id, o.account_id, 'BTC-SIM', -f.quantity
            from fills f join orders o on o.id = f.sell_order_id
          union all
          select f.session_id, o.account_id, 'USD-SIM', -f.notional - f.buyer_fee
            from fills f join orders o on o.id = f.buy_order_id
          union all
          select f.session_id, o.account_id, 'USD-SIM', f.notional - f.seller_fee
            from fills f join orders o on o.id = f.sell_order_id
        ), expected_totals as (
          select session_id, account_id, asset, sum(amount) as amount
          from expected_moves group by session_id, account_id, asset
        ), actual_totals as (
          select b.session_id, b.account_id, b.asset, sum(b.amount) as amount
          from balances b join accounts a on a.id = b.account_id where a.kind = 'TRADER'
          group by b.session_id, b.account_id, b.asset
        )
        select coalesce(e.session_id, a.session_id)::text || '/' ||
          coalesce(e.account_id, a.account_id)::text || '/' || coalesce(e.asset, a.asset) as detail
        from expected_totals e full outer join actual_totals a using (session_id, account_id, asset)
        where coalesce(e.amount, 0) <> coalesce(a.amount, 0)
      `,
    },
    {
      code: 'ORDER_RESERVATION',
      query: sql`
        select id::text as detail from orders
        where reserved_amount <> case
          when status in ('FILLED', 'CANCELED') then 0
          when side = 'BUY' then remaining_quantity * price * 1001
          else remaining_quantity
        end
          or quantity <= 0 or price <= 0
          or remaining_quantity < 0 or remaining_quantity > quantity
          or (status = 'OPEN' and remaining_quantity <> quantity)
          or (status = 'PARTIALLY_FILLED' and
            (remaining_quantity <= 0 or remaining_quantity >= quantity))
          or (status = 'FILLED' and remaining_quantity <> 0)
          or (status = 'CANCELED' and remaining_quantity <= 0)
          or (type = 'MARKET' and status in ('OPEN', 'PARTIALLY_FILLED'))
      `,
    },
    {
      code: 'RESERVED_PROJECTION',
      query: sql`
        with order_reserves as (
          select session_id, account_id,
            case when side = 'BUY' then 'USD-SIM' else 'BTC-SIM' end as asset,
            sum(reserved_amount) as amount
          from orders where status in ('OPEN', 'PARTIALLY_FILLED')
          group by session_id, account_id, side
        ), reserved_balances as (
          select * from balances where bucket = 'RESERVED'
        )
        select coalesce(b.session_id, o.session_id)::text || '/' ||
          coalesce(b.account_id, o.account_id)::text || '/' || coalesce(b.asset, o.asset) as detail
        from reserved_balances b full outer join order_reserves o
          using (session_id, account_id, asset)
        where coalesce(b.amount, 0) <> coalesce(o.amount, 0)
      `,
    },
    {
      code: 'ORDER_FILLED_QUANTITY',
      query: sql`
        with order_fills as (
          select buy_order_id as order_id, quantity from fills
          union all select sell_order_id as order_id, quantity from fills
        ), filled_totals as (
          select order_id, sum(quantity) as amount from order_fills group by order_id
        )
        select o.id::text as detail from orders o
        left join filled_totals f on f.order_id = o.id
        where o.quantity - o.remaining_quantity <> coalesce(f.amount, 0)
      `,
    },
    {
      code: 'FILL_RULES',
      query: sql`
        select f.id::text as detail from fills f
        join orders b on b.id = f.buy_order_id
        join orders s on s.id = f.sell_order_id
        join orders m on m.id = f.maker_order_id
        join orders t on t.id = f.taker_order_id
        where f.quantity <= 0 or f.price <= 0
          or f.notional <> f.quantity * f.price * 1000
          or f.buyer_fee <> f.quantity * f.price
          or f.seller_fee <> f.quantity * f.price
          or b.side <> 'BUY' or s.side <> 'SELL' or b.account_id = s.account_id
          or f.price <> m.price or f.price > b.price or f.price < s.price
          or m.acceptance_sequence >= t.acceptance_sequence
          or f.sequence <> t.acceptance_sequence
          or f.session_id <> b.session_id or f.session_id <> s.session_id
          or f.session_id <> m.session_id or f.session_id <> t.session_id
      `,
    },
    {
      code: 'FILL_ORDER',
      query: sql`
        select session_id::text || '/' || sequence::text as detail from fills
        group by session_id, sequence
        having min(fill_index) <> 0 or max(fill_index) <> count(*) - 1
      `,
    },
    {
      code: 'CROSSED_BOOK',
      query: sql`
        select session_id::text as detail from orders
        where status in ('OPEN', 'PARTIALLY_FILLED')
        group by session_id
        having max(price) filter (where side = 'BUY') >=
          min(price) filter (where side = 'SELL')
      `,
    },
    {
      code: 'SYSTEM_ACCOUNTS',
      query: sql`
        select 'Initialized installation requires one fee and one issuance account' as detail
        where exists (select 1 from exchange_sessions)
          and ((select count(*) from accounts where kind = 'FEE') <> 1
            or (select count(*) from accounts where kind = 'ISSUANCE') <> 1)
      `,
    },
    {
      code: 'FEE_TOTAL',
      query: sql`
        with fill_fees as (
          select session_id, sum(buyer_fee + seller_fee) as amount
          from fills group by session_id
        ), fee_balances as (
          select b.session_id, sum(b.amount) as amount
          from balances b join accounts a on a.id = b.account_id
          where a.kind = 'FEE' and b.asset = 'USD-SIM' and b.bucket = 'AVAILABLE'
          group by b.session_id
        )
        select coalesce(f.session_id, b.session_id)::text as detail
        from fill_fees f full outer join fee_balances b using (session_id)
        where coalesce(f.amount, 0) <> coalesce(b.amount, 0)
        union all
        select b.session_id::text || '/' || b.asset || '/' || b.bucket as detail
        from balances b join accounts a on a.id = b.account_id
        where a.kind = 'FEE' and (b.asset <> 'USD-SIM' or b.bucket <> 'AVAILABLE') and b.amount <> 0
      `,
    },
    {
      code: 'GRANT_JOURNAL',
      query: sql`
        select g.id::text as detail from grants g
        join accounts recipient on recipient.id = g.account_id
        join users actor on actor.account_id = g.actor_id
        where recipient.kind <> 'TRADER' or actor.role <> 'ADMIN' or not (
          exists (select 1 from users where account_id = g.account_id and role = 'TRADER')
          or exists (select 1 from demo_market where session_id = g.session_id
            and g.account_id in (maker_account_id, taker_account_id))
        ) or not exists (
          select j.id from journal_transactions j
          join journal_entries e on e.journal_transaction_id = j.id
          join accounts owner on owner.id = e.account_id
          where j.session_id = g.session_id and j.command_id = g.command_id and j.kind = 'GRANT'
          group by j.id
          having count(*) = 2 and
            coalesce(sum(e.amount) filter (where e.account_id = g.account_id
              and e.asset = g.asset and e.bucket = 'AVAILABLE'), 0) = g.amount
            and coalesce(sum(e.amount) filter (where owner.kind = 'ISSUANCE'
              and e.asset = g.asset and e.bucket = 'AVAILABLE'), 0) = -g.amount
        )
      `,
    },
    {
      code: 'ISSUANCE_TOTAL',
      query: sql`
        with issued as (
          select session_id, 'BTC-SIM' as asset, -10000::numeric as amount from allocations
          union all
          select session_id, 'USD-SIM', -100000000000000::numeric from allocations
          union all
          select session_id, asset, -amount from grants
        ), expected as (
          select session_id, asset, sum(amount) as amount from issued group by session_id, asset
        ), actual as (
          select b.session_id, b.asset, sum(b.amount) as amount from balances b
          join accounts a on a.id = b.account_id where a.kind = 'ISSUANCE'
          group by b.session_id, b.asset
        )
        select coalesce(e.session_id, a.session_id)::text || '/' || coalesce(e.asset, a.asset) as detail
        from expected e full outer join actual a using (session_id, asset)
        where coalesce(e.amount, 0) <> coalesce(a.amount, 0)
        union all
        select b.session_id::text || '/' || b.asset || '/RESERVED' as detail from balances b
        join accounts a on a.id = b.account_id
        where a.kind = 'ISSUANCE' and b.bucket = 'RESERVED' and b.amount <> 0
      `,
    },
    {
      code: 'ADMINISTRATOR_ISOLATION',
      query: sql`
        select a.id::text as detail from accounts a where a.kind = 'ADMIN' and (
          exists (select 1 from balances b where b.account_id = a.id)
          or exists (select 1 from orders o where o.account_id = a.id)
          or exists (select 1 from allocations l where l.account_id = a.id)
          or exists (select 1 from journal_entries e where e.account_id = a.id)
        )
      `,
    },
    {
      code: 'SUSPENSION_CANCELLATION',
      query: sql`
        select u.account_id::text as detail from users u
        where u.status = 'SUSPENDED' and not u.pending_cancellation and exists (
          select 1 from orders o where o.account_id = u.account_id
            and o.status in ('OPEN', 'PARTIALLY_FILLED')
        )
      `,
    },
    {
      code: 'INITIAL_ALLOCATION',
      query: sql`
        select a.session_id::text || '/' || a.account_id::text as detail from allocations a
        where not exists (
          select j.id from journal_transactions j
          join journal_entries e on e.journal_transaction_id = j.id
          join accounts owner on owner.id = e.account_id
          where j.session_id = a.session_id and j.command_id = a.command_id and j.kind = 'ALLOCATE'
          group by j.id
          having coalesce(sum(e.amount) filter (
            where e.account_id = a.account_id and e.asset = 'BTC-SIM' and e.bucket = 'AVAILABLE'
          ), 0) = 10000
            and coalesce(sum(e.amount) filter (
              where e.account_id = a.account_id and e.asset = 'USD-SIM' and e.bucket = 'AVAILABLE'
            ), 0) = 100000000000000
            and coalesce(sum(e.amount) filter (
              where owner.kind = 'ISSUANCE' and e.asset = 'BTC-SIM' and e.bucket = 'AVAILABLE'
            ), 0) = -10000
            and coalesce(sum(e.amount) filter (
              where owner.kind = 'ISSUANCE' and e.asset = 'USD-SIM' and e.bucket = 'AVAILABLE'
            ), 0) = -100000000000000
        )
        union all
        select distinct b.session_id::text || '/' || b.account_id::text as detail
        from balances b join accounts owner on owner.id = b.account_id
        where owner.kind = 'TRADER' and not exists (
          select 1 from allocations a where a.session_id = b.session_id and a.account_id = b.account_id
        )
      `,
    },
  ];

  const issues: string[] = [];
  for (const check of checks) {
    // Bound diagnostics without pulling an unbounded damaged history into Node.
    // The aggregate checks still inspect complete persisted financial history.
    const result = await sql<{ detail: string }>`
      select detail from (${check.query}) as violations limit ${MAX_ISSUES - issues.length + 1}
    `.execute(database);
    for (const { detail } of result.rows) {
      if (issues.length === MAX_ISSUES) {
        return { ok: false, issues: [...issues, 'Additional reconciliation issues omitted.'] };
      }
      issues.push(`${check.code}: ${detail}`);
    }
  }
  return { ok: issues.length === 0, issues };
}
