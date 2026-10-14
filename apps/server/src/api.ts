import Fastify, { LogController, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import * as S from '@sandbox/contracts';
import { DomainError } from '@sandbox/domain';
import { DatabaseTimeoutError } from '@sandbox/database';
import { AdminService } from './admin/index.js';
import { AuthError, AuthService, requirePrincipal, type LoginResult } from './auth/index.js';
import {
  Exchange,
  CommandConflictError,
  RecoveryError,
  WriterUnavailableError,
} from './exchange.js';
import { marketSnapshot, privateOrder } from './queries.js';
import { workspaceSnapshot, inspectAccount } from './workspace.js';
import {
  sessionsSnapshot,
  historySnapshot,
  historyPage,
  historyExport,
  searchAccounts,
} from './history/index.js';
import { LiveUpdates, type LiveOptions } from './live.js';
import { AdmissionError, installHttpAdmission, type HttpAdmissionOptions } from './admission.js';

export interface ApiOptions {
  exchange: Exchange;
  auth: AuthService;
  admin?: AdminService;
  origin: string;
  secureCookies: boolean;
  logger?: boolean;
  admission?: HttpAdmissionOptions;
  live?: LiveOptions;
  /** One trusted reverse-proxy hop is valid only while the backend port stays private. */
  proxyHops?: 0 | 1;
}

/** Owns HTTP resources only. The composition root owns Exchange's lifetime. */
export async function buildApi(options: ApiOptions) {
  const expectedOrigin = new URL(options.origin);
  if (!['http:', 'https:'].includes(expectedOrigin.protocol))
    throw new Error('API origin must use HTTP or HTTPS.');
  if (expectedOrigin.origin !== options.origin)
    throw new Error('API origin must be an exact origin without a path.');
  if (
    !options.secureCookies &&
    !['localhost', '127.0.0.1', '[::1]'].includes(expectedOrigin.hostname)
  ) {
    throw new Error('Insecure cookies are permitted only for loopback development.');
  }
  if (options.secureCookies && expectedOrigin.protocol !== 'https:')
    throw new Error('Secure cookies require an HTTPS origin.');
  const app = Fastify({
    logger: options.logger
      ? {
          level: 'info',
          base: null,
          redact: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers["x-csrf-token"]',
            'res.headers["set-cookie"]',
          ],
        }
      : false,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: options.proxyHops === 1 ? (_address: string, hop: number) => hop === 0 : false,
    bodyLimit: 16_384,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
    ajv: { customOptions: { coerceTypes: false, removeAdditional: false, useDefaults: false } },
  }).withTypeProvider<TypeBoxTypeProvider>();
  const admission = installHttpAdmission(app, options.admission);
  const { auth, exchange } = options;
  const admin = options.admin ?? new AdminService(exchange);
  const live = new LiveUpdates(exchange, options.live);
  app.addHook('preClose', async () => live.close());
  await app.register(cookie);
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Spot Exchange Simulator API',
        version: '0.2.0',
        description:
          'Virtual BTC-SIM / USD-SIM. Cookie authentication with exact-origin and CSRF checks.',
      },
      components: {
        securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: 'sandbox_session' } },
      },
    },
  });
  app.addHook('onRequest', async (request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Frame-Options', 'DENY');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (
        request.headers.origin !== options.origin ||
        request.headers['sec-fetch-site'] === 'cross-site'
      ) {
        throw new AuthError('ORIGIN_INVALID', 'Use the configured application origin.', 403);
      }
      if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw new AuthError('CONTENT_TYPE_REQUIRED', 'Use application/json.', 415);
      }
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        method: request.method,
        route: request.routeOptions.url ?? 'unmatched',
        statusCode: reply.statusCode,
        elapsedMs: reply.elapsedTime,
      },
      'HTTP response',
    );
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AdmissionError)
      return reply.code(503).send({ code: error.code, message: error.message });
    if (error instanceof AuthError)
      return reply.code(error.statusCode).send({ code: error.code, message: error.message });
    if (error instanceof DomainError)
      return reply.code(400).send({ code: error.code, message: error.message });
    if (error instanceof CommandConflictError)
      return reply.code(409).send({ code: error.code, message: error.message });
    if (error instanceof RecoveryError || error instanceof WriterUnavailableError)
      return reply.code(503).send({
        code: error.code,
        message: 'Trading is unavailable; inspect the administrator status.',
      });
    const detail = error as { statusCode?: number; validation?: unknown; code?: string };
    if (
      error instanceof DatabaseTimeoutError ||
      ['57014', '25P03', '25P04'].includes(detail.code ?? '')
    )
      return reply.code(503).send({
        code: 'DATABASE_TIMEOUT',
        message:
          'Database work exceeded its resource budget. Resolve an uncertain command by its original identity before retrying.',
      });
    if (detail.code === '55P03')
      return reply.code(503).send({
        code: 'ADMISSION_BUSY',
        message:
          'A database lock is busy. Retry reads; resolve an uncertain command by its original identity.',
      });
    if (detail.validation)
      return reply
        .code(400)
        .send({ code: 'INVALID_REQUEST', message: 'The request does not match the API schema.' });
    if (detail.statusCode && detail.statusCode >= 400 && detail.statusCode < 500)
      return reply.code(detail.statusCode).send({
        code: detail.statusCode === 429 ? 'RATE_LIMITED' : 'INVALID_REQUEST',
        message:
          detail.statusCode === 429
            ? 'Too many requests; retry later.'
            : 'The request could not be accepted.',
      });
    request.log.error(
      { requestId: request.id, code: detail.code ?? 'INTERNAL_ERROR' },
      'API request failed',
    );
    return reply.code(500).send({
      code: 'INTERNAL_ERROR',
      message:
        'The request could not be completed. Resolve an uncertain command by its original identity.',
    });
  });
  const token = (request: FastifyRequest) => request.cookies.sandbox_session ?? '';
  const protect = (role?: 'ADMIN' | 'TRADER') => async (request: FastifyRequest) =>
    admission.run(request, async () => {
      const mutating = request.method !== 'GET' && request.method !== 'HEAD';
      const csrf = request.headers['x-csrf-token'];
      if (mutating && (typeof csrf !== 'string' || !csrf))
        throw new AuthError('CSRF_INVALID', 'A CSRF token is required.', 403);
      const principal = await auth.authenticate(
        token(request),
        mutating ? (csrf as string) : undefined,
      );
      const expectedActor = request.headers['x-sandbox-actor'];
      if (expectedActor !== undefined && expectedActor !== principal.accountId)
        throw new AuthError(
          'SESSION_CHANGED',
          'The signed-in account changed. Refresh the workspace before continuing.',
          401,
        );
      if (role && principal.role !== role)
        throw new AuthError('FORBIDDEN', 'This action is not available to this account.', 403);
    });
  const setSession = (reply: FastifyReply, result: LoginResult) => {
    const common = {
      secure: options.secureCookies,
      sameSite: 'strict' as const,
      path: '/',
      expires: new Date(result.expiresAt),
    };
    reply.setCookie('sandbox_session', result.token, { ...common, httpOnly: true });
    reply.setCookie('sandbox_csrf', result.csrfToken, { ...common, httpOnly: false });
    return { user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  };
  const errors = { '4xx': S.ErrorResult, '5xx': S.ErrorResult };
  const security = [{ cookieAuth: [] }];
  const authRate = { rateLimit: { max: 20, timeWindow: '1 minute' } };
  app.get('/health/live', async () => ({ alive: true }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const ready = await exchange.accessTransaction(
        async (tx, control) =>
          !control.fault &&
          !control.rollover_operation_id &&
          Boolean(control.active_session_id) &&
          Boolean(
            await tx
              .selectFrom('users')
              .select('account_id')
              .where('role', '=', 'ADMIN')
              .executeTakeFirst(),
          ),
      );
      return reply.code(ready ? 200 : 503).send({ ready });
    } catch {
      return reply.code(503).send({ ready: false });
    }
  });
  app.post(
    '/api/auth/login',
    { config: authRate, schema: { body: S.Login, response: { 200: S.LoginResult, ...errors } } },
    async (request, reply) => setSession(reply, await auth.login(request.body)),
  );
  app.post(
    '/api/auth/redeem',
    { config: authRate, schema: { body: S.Redeem, response: { 200: S.JoinResult, ...errors } } },
    async (request) => auth.redeemInvitation(request.body),
  );
  app.post(
    '/api/auth/recover',
    { config: authRate, schema: { body: S.Recover, response: { 200: S.Ok, ...errors } } },
    async (request) => {
      await auth.redeemRecovery(request.body);
      return { ok: true };
    },
  );
  app.get(
    '/api/auth/session',
    {
      preHandler: protect(),
      schema: {
        security,
        response: {
          200: { type: 'object', properties: { user: S.User }, required: ['user'] },
          ...errors,
        },
      },
    },
    async (request) => {
      const { accountId, handle, role } = await auth.authenticate(token(request));
      return { user: { accountId, handle, role } };
    },
  );
  app.post(
    '/api/auth/logout',
    {
      preHandler: protect(),
      schema: { security, body: S.Empty, response: { 200: S.Ok, ...errors } },
    },
    async (request, reply) => {
      await auth.logout(token(request));
      reply.clearCookie('sandbox_session', {
        path: '/',
        secure: options.secureCookies,
        sameSite: 'strict',
        httpOnly: true,
      });
      reply.clearCookie('sandbox_csrf', {
        path: '/',
        secure: options.secureCookies,
        sameSite: 'strict',
      });
      return { ok: true };
    },
  );
  app.post(
    '/api/auth/password',
    {
      preHandler: protect(),
      config: authRate,
      schema: { security, body: S.ChangePassword, response: { 200: S.LoginResult, ...errors } },
    },
    async (request, reply) =>
      setSession(reply, await auth.changePassword(token(request), request.body)),
  );
  app.get(
    '/api/workspace',
    {
      preHandler: protect(),
      schema: { security, response: { 200: S.Workspace, ...errors } },
    },
    async (request) => workspaceSnapshot(exchange, token(request)),
  );
  app.get(
    '/api/admin/traders/:id/workspace',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        querystring: S.SessionQuery,
        response: { 200: S.AccountWorkspace, ...errors },
      },
    },
    async (request) =>
      inspectAccount(exchange, token(request), request.params.id, request.query.sessionId),
  );
  app.get(
    '/api/sessions',
    {
      preHandler: protect(),
      schema: { security, querystring: S.SessionsQuery, response: { 200: S.Sessions, ...errors } },
    },
    async (request) => sessionsSnapshot(exchange, token(request), request.query),
  );
  app.get(
    '/api/history/:sessionId',
    {
      preHandler: protect(),
      schema: { security, params: S.SessionParam, response: { 200: S.History, ...errors } },
    },
    async (request) => historySnapshot(exchange, token(request), request.params.sessionId),
  );
  app.get(
    '/api/history/:sessionId/page',
    {
      preHandler: protect(),
      schema: {
        security,
        params: S.SessionParam,
        querystring: S.HistoryPageQuery,
        response: { 200: S.HistoryPage, ...errors },
      },
    },
    async (request) =>
      historyPage(exchange, token(request), request.params.sessionId, request.query),
  );
  app.get(
    '/api/history/:sessionId/export',
    {
      preHandler: protect(),
      schema: {
        security,
        params: S.SessionParam,
        querystring: S.HistoryExportQuery,
        response: { 200: S.HistoryExport, ...errors },
      },
    },
    async (request) =>
      historyExport(exchange, token(request), request.params.sessionId, request.query.accountId),
  );
  app.get(
    '/api/admin/accounts/search',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        querystring: S.AccountSearchQuery,
        response: { 200: S.AccountSearch, ...errors },
      },
    },
    async (request) => searchAccounts(exchange, token(request), request.query),
  );
  app.get(
    '/api/events',
    {
      preHandler: protect(),
      schema: { security, querystring: S.StreamQuery, response: { ...errors } },
    },
    async (request, reply) => {
      if (
        request.headers['sec-fetch-site'] === 'cross-site' ||
        (request.headers.origin && request.headers.origin !== options.origin)
      ) {
        throw new AuthError('ORIGIN_INVALID', 'Use the configured application origin.', 403);
      }
      const last = request.headers['last-event-id'];
      if (
        last !== undefined &&
        (typeof last !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(last))
      ) {
        throw new AuthError('CURSOR_INVALID', 'Use a valid stream cursor.', 400);
      }
      return live.connect(
        reply,
        token(request),
        request.query.sessionId,
        last ?? request.query.cursor,
      );
    },
  );
  app.get(
    '/api/market',
    { preHandler: protect(), schema: { security, response: { 200: S.Market, ...errors } } },
    async (request) => marketSnapshot(exchange, token(request)),
  );
  app.get(
    '/api/me',
    {
      preHandler: protect('TRADER'),
      schema: { security, response: { 200: S.Snapshot, ...errors } },
    },
    async (request) => {
      const actor = await auth.authenticate(token(request));
      return {
        ...(await exchange.snapshot(actor.accountId, token(request), 100)),
        historyLimit: 100,
      };
    },
  );
  app.post(
    '/api/orders',
    {
      preHandler: protect('TRADER'),
      schema: { security, body: S.OrderCommand, response: { 200: S.CommandResult, ...errors } },
    },
    async (request) => {
      const actor = await auth.authenticate(token(request));
      return exchange.placeLimit({ ...request.body, accountId: actor.accountId }, token(request));
    },
  );
  app.post(
    '/api/orders/market/preview',
    {
      preHandler: protect('TRADER'),
      schema: {
        security,
        body: S.MarketPreviewRequest,
        response: { 200: S.MarketPreview, ...errors },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(token(request));
      return exchange.previewMarket(
        { ...request.body, accountId: actor.accountId },
        token(request),
      );
    },
  );
  app.post(
    '/api/orders/market',
    {
      preHandler: protect('TRADER'),
      schema: {
        security,
        body: S.MarketOrderCommand,
        response: { 200: S.CommandResult, ...errors },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(token(request));
      return exchange.placeMarket({ ...request.body, accountId: actor.accountId }, token(request));
    },
  );
  app.post(
    '/api/orders/:orderId/cancel',
    {
      preHandler: protect('TRADER'),
      schema: {
        security,
        params: S.OrderParam,
        body: S.CancelCommand,
        response: { 200: S.CommandResult, ...errors },
      },
    },
    async (request) => {
      const actor = await auth.authenticate(token(request));
      return exchange.cancel(
        { ...request.body, orderId: request.params.orderId, accountId: actor.accountId },
        token(request),
      );
    },
  );
  app.get(
    '/api/orders/:orderId',
    {
      preHandler: protect('TRADER'),
      schema: {
        security,
        params: S.OrderParam,
        response: {
          200: S.OrderDetail,
          ...errors,
        },
      },
    },
    async (request) => privateOrder(exchange, token(request), request.params.orderId),
  );
  app.get(
    '/api/admin/orders/:orderId',
    {
      preHandler: protect('ADMIN'),
      schema: { security, params: S.OrderParam, response: { 200: S.OrderDetail, ...errors } },
    },
    async (request) => privateOrder(exchange, token(request), request.params.orderId),
  );
  app.get(
    '/api/receipts/:commandId',
    {
      preHandler: protect(),
      schema: { security, params: S.CommandParam, response: { 200: S.Receipt, ...errors } },
    },
    async (request) =>
      exchange.accessTransaction(async (tx) => {
        const actor = await requirePrincipal(tx, token(request));
        const receipt = await tx
          .selectFrom('receipts')
          .select('result')
          .where('actor_id', '=', actor.accountId)
          .where('command_id', '=', request.params.commandId)
          .executeTakeFirst();
        if (!receipt || !('status' in receipt.result)) return null;
        // Trading receipts contain both orders internally; only owner-safe fills leave HTTP.
        const result = { ...receipt.result };
        if (Array.isArray(result.fills))
          result.fills = result.fills.map((value: Record<string, unknown>) => {
            const {
              makerOrderId: _maker,
              takerOrderId: _taker,
              buyOrderId: _buy,
              sellOrderId: _sell,
              ...safe
            } = value;
            return safe;
          });
        return result;
      }),
  );
  app.get(
    '/api/admin/invitations',
    {
      preHandler: protect('ADMIN'),
      schema: { security, response: { 200: S.Invitations, ...errors } },
    },
    async (request) => auth.listInvitations(token(request)),
  );
  app.post(
    '/api/admin/invitations',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => auth.issueInvitation(token(request), request.body),
  );
  app.post(
    '/api/admin/invitations/:id/revoke',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        body: S.AdminCommand,
        response: { 200: S.AdminResult, ...errors },
      },
    },
    async (request) =>
      auth.revokeInvitation(token(request), { ...request.body, invitationId: request.params.id }),
  );
  app.get(
    '/api/admin/traders',
    { preHandler: protect('ADMIN'), schema: { security, response: { 200: S.Traders, ...errors } } },
    async (request) => admin.listTraders(token(request)),
  );
  app.get(
    '/api/admin/traders/:id',
    {
      preHandler: protect('ADMIN'),
      schema: { security, params: S.IdParam, response: { 200: S.AdminSnapshot, ...errors } },
    },
    async (request) => ({
      ...(await exchange.snapshot(request.params.id, token(request), 100)),
      historyLimit: 100,
    }),
  );
  app.post(
    '/api/admin/traders/:id/recovery',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        body: S.AdminCommand,
        response: { 200: S.AdminResult, ...errors },
      },
    },
    async (request) =>
      auth.issueRecovery(token(request), { ...request.body, accountId: request.params.id }),
  );
  app.post(
    '/api/admin/traders/:id/suspend',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        body: S.AdminCommand,
        response: { 200: S.AdminResult, ...errors },
      },
    },
    async (request) =>
      admin.suspend(token(request), { ...request.body, accountId: request.params.id }),
  );
  app.post(
    '/api/admin/traders/:id/reinstate',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        body: S.AdminCommand,
        response: { 200: S.AdminResult, ...errors },
      },
    },
    async (request) =>
      admin.reinstate(token(request), { ...request.body, accountId: request.params.id }),
  );
  app.post(
    '/api/admin/market/pause',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.pause(token(request), request.body),
  );
  app.post(
    '/api/admin/sessions/rollover',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.rollover(token(request), request.body),
  );
  app.post(
    '/api/admin/market/resume',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.resume(token(request), request.body),
  );
  app.post(
    '/api/admin/simulator/start',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.startSimulator(token(request), request.body),
  );
  app.post(
    '/api/admin/simulator/stop',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.stopSimulator(token(request), request.body),
  );
  app.post(
    '/api/admin/orders/:id/cancel',
    {
      preHandler: protect('ADMIN'),
      schema: {
        security,
        params: S.IdParam,
        body: S.AdminCommand,
        response: { 200: S.AdminResult, ...errors },
      },
    },
    async (request) =>
      admin.cancelOrder(token(request), { ...request.body, orderId: request.params.id }),
  );
  app.post(
    '/api/admin/grants',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.GrantCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.grant(token(request), request.body),
  );
  app.post(
    '/api/admin/reconcile',
    {
      preHandler: protect('ADMIN'),
      schema: { security, body: S.AdminCommand, response: { 200: S.AdminResult, ...errors } },
    },
    async (request) => admin.reconcile(token(request), request.body),
  );
  app.get(
    '/api/admin/audit',
    { preHandler: protect('ADMIN'), schema: { security, response: { 200: S.Audit, ...errors } } },
    async (request) => admin.listAudits(token(request)),
  );
  app.get(
    '/api/admin/overview',
    {
      preHandler: protect('ADMIN'),
      schema: { security, response: { 200: S.Overview, ...errors } },
    },
    async (request) => admin.overview(token(request)),
  );
  app.get(
    '/api/openapi.json',
    { preHandler: protect(), schema: { security, hide: true } },
    async () => app.swagger(),
  );
  return app;
}
