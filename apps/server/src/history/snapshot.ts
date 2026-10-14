import type {
  HistoryView,
  SessionsQueryInput,
  SessionsView,
  AccountSearchQueryInput,
  AccountSearchView,
} from '@sandbox/contracts';
import { formatPrice } from '@sandbox/domain';
import { requirePrincipal } from '../auth/access.js';
import type { Exchange } from '../exchange.js';
import { simulatorInventory } from '../demo-market/inventory.js';
import { accountWorkspace, adminWorkspace, marketWorkspace } from '../workspace.js';
import {
  decodeCursor,
  encodeCursor,
  historyContext,
  sessionSummary,
  textPattern,
  pageLimit,
  timestampPosition,
  uuidPosition,
} from './context.js';
import { sql } from 'kysely';

export async function sessionsSnapshot(
  exchange: Exchange,
  token: string,
  query: SessionsQueryInput = {},
): Promise<SessionsView> {
  return exchange.readTransaction(async (tx) => {
    const actor = await requirePrincipal(tx, token);
    const context = `sessions:${actor.accountId}`;
    const position = decodeCursor(query.cursor, context, 2);
    let selection = tx
      .selectFrom('exchange_sessions')
      .selectAll()
      .select(
        sql<string>`to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`.as(
          'cursor_timestamp',
        ),
      );
    timestampPosition(position);
    uuidPosition(position, 1);
    if (position) {
      selection = selection.where(
        sql<boolean>`(created_at, id) < (${position[0]}::timestamptz, ${position[1]}::uuid)`,
      );
    }
    const limit = pageLimit(query.limit);
    const rows = await selection
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      sessions: items.map(sessionSummary),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(context, [last.cursor_timestamp, last.id])
          : null,
    };
  });
}

export async function historySnapshot(
  exchange: Exchange,
  token: string,
  sessionId: string,
): Promise<HistoryView> {
  return exchange.readTransaction(async (tx) => {
    const { actor, session, asOf, cursor } = await historyContext(tx, token, sessionId);
    const control = await tx
      .selectFrom('exchange_control')
      .selectAll()
      .where('id', '=', 1)
      .executeTakeFirstOrThrow();
    const demo = await tx
      .selectFrom('demo_market')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();
    const live = session.state === 'ACTIVE' && control.active_session_id === sessionId;
    const fault = live ? (exchange.getRuntimeFault() ?? control.fault) : null;
    const state = live ? control.market_state : 'PAUSED';
    const demoMarket = demo
      ? {
          enabled: live && demo.enabled,
          status: !live
            ? 'STOPPED'
            : demo.enabled && fault
              ? 'FAULTED'
              : demo.enabled && state === 'PAUSED'
                ? 'PAUSED'
                : demo.status,
          updatedAt: demo.updated_at.toISOString(),
        }
      : undefined;
    const market = {
      ...(await marketWorkspace(tx, sessionId)),
      ...(demoMarket ? { demoMarket } : {}),
    };
    return {
      user: { accountId: actor.accountId, handle: actor.handle, role: actor.role },
      session: sessionSummary(session),
      asOf,
      cursor,
      market,
      historyLimit: 100,
      ...(actor.role === 'TRADER'
        ? { account: await accountWorkspace(tx, sessionId, actor.accountId) }
        : {
            admin: await adminWorkspace(
              tx,
              sessionId,
              state,
              fault,
              demo && demoMarket
                ? {
                    ...demoMarket,
                    makerAccountId: demo.maker_account_id,
                    takerAccountId: demo.taker_account_id,
                    referencePrice: formatPrice(BigInt(demo.reference_price)),
                    inventory: await simulatorInventory(
                      tx,
                      sessionId,
                      demo.maker_account_id,
                      demo.taker_account_id,
                      BigInt(demo.reference_price),
                    ),
                  }
                : undefined,
              { sessionAudit: true, allocatedOnly: session.state === 'CLOSED' },
            ),
          }),
    };
  });
}

export async function searchAccounts(
  exchange: Exchange,
  token: string,
  query: AccountSearchQueryInput = {},
): Promise<AccountSearchView> {
  return exchange.readTransaction(async (tx) => {
    const actor = await requirePrincipal(tx, token, 'ADMIN');
    const search = query.search?.trim() ?? '';
    const context = JSON.stringify(['accounts', actor.accountId, search]);
    const position = decodeCursor(query.cursor, context, 2);
    let selection = tx
      .selectFrom('users')
      .select([
        'account_id',
        'handle',
        'status',
        'suspension_reason',
        'pending_cancellation',
        'created_at',
      ])
      .where('role', '=', 'TRADER');
    if (search)
      selection = selection.where((eb) =>
        eb.or([
          eb('handle', 'ilike', textPattern(search)),
          sql<boolean>`account_id::text ILIKE ${textPattern(search)}`,
        ]),
      );
    if (position) {
      uuidPosition(position, 1);
      selection = selection.where(
        sql<boolean>`(handle, account_id) > (${position[0]}, ${position[1]}::uuid)`,
      );
    }
    const limit = pageLimit(query.limit);
    const rows = await selection
      .orderBy('handle')
      .orderBy('account_id')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => ({
        accountId: row.account_id,
        handle: row.handle,
        status: row.status,
        suspensionReason: row.suspension_reason,
        pendingCancellation: row.pending_cancellation,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor:
        rows.length > limit && last ? encodeCursor(context, [last.handle, last.account_id]) : null,
    };
  });
}
