import type { FastifyRequest } from 'fastify';
import type { DiagnosticContext } from './diagnostics.js';

const operations: Record<string, string> = {
  '/api/orders': 'limit_order',
  '/api/orders/market': 'market_order',
  '/api/orders/market/preview': 'market_preview',
  '/api/orders/:orderId/cancel': 'cancel_order',
  '/api/admin/market/resume': 'market_resume',
  '/api/admin/market/pause': 'market_pause',
  '/api/admin/grants': 'grant',
  '/api/admin/reconcile': 'reconcile',
  '/api/admin/sessions/rollover': 'session_rollover',
  '/api/admin/simulator/start': 'simulator_start',
  '/api/admin/simulator/stop': 'simulator_stop',
  '/api/admin/invitations': 'invitation_issue',
  '/api/admin/invitations/:id/revoke': 'invitation_revoke',
  '/api/admin/traders/:id/suspend': 'suspend',
  '/api/admin/traders/:id/reinstate': 'reinstate',
  '/api/admin/traders/:id/recovery': 'password_recover',
  '/api/auth/redeem': 'invitation_redeem',
  '/api/auth/recover': 'password_recover',
  '/api/auth/password': 'password_rotate',
  '/api/admin/diagnostics': 'diagnostics',
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Route templates and validated identities only; never a URL, query or body object. */
export function diagnosticContext(request: FastifyRequest): DiagnosticContext {
  const route = request.routeOptions.url ?? '';
  const operation =
    request.method === 'GET'
      ? route === '/api/admin/diagnostics'
        ? 'diagnostics'
        : 'read'
      : (operations[route] ??
        (route.startsWith('/api/auth/')
          ? 'authentication'
          : route.startsWith('/api/admin/')
            ? 'admin_command'
            : 'other'));
  const body = request.body as Record<string, unknown> | null | undefined;
  const identities: { commandId?: string; sessionId?: string } = {};
  for (const name of ['commandId', 'sessionId'] as const) {
    const value = body?.[name];
    if (typeof value === 'string' && uuid.test(value)) identities[name] = value;
  }
  return { requestId: request.id, operation, ...identities };
}
