import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApi } from '../../apps/server/src/api.js';
import type { LiveOptions } from '../../apps/server/src/live.js';
import type { HttpAdmissionOptions } from '../../apps/server/src/admission.js';
import { AuthService } from '../../apps/server/src/auth/index.js';
import { Exchange } from '../../apps/server/src/exchange.js';
import type { ExchangeOptions } from '../../apps/server/src/types.js';

export const API_ORIGIN = 'http://localhost:3000';
export const TEST_PASSWORD = 'simulation-test-password';

type Api = Awaited<ReturnType<typeof buildApi>>;
type Method = 'GET' | 'POST';
type Headers = Record<string, string>;

/** An independent browser cookie jar, including its matching CSRF token. */
export class ApiClient {
  private cookies = new Map<string, string>();
  csrfToken = '';

  constructor(
    private readonly app: () => Api,
    private readonly origin = API_ORIGIN,
  ) {}

  get cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method: Method, url: string, payload?: unknown, overrides: Headers = {}) {
    const headers: Headers = { origin: this.origin, ...overrides };
    if (this.cookieHeader) headers.cookie = this.cookieHeader;
    if (this.csrfToken && !('x-csrf-token' in overrides)) {
      headers['x-csrf-token'] = this.csrfToken;
    }
    const response = await this.app().inject({
      method,
      url,
      headers,
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
      ...(payload !== undefined
        ? { headers: { 'content-type': 'application/json', ...headers } }
        : {}),
    });
    const setCookie = response.headers['set-cookie'];
    for (const value of typeof setCookie === 'string' ? [setCookie] : (setCookie ?? [])) {
      const pair = value.split(';', 1)[0]!;
      const boundary = pair.indexOf('=');
      this.cookies.set(pair.slice(0, boundary), pair.slice(boundary + 1));
    }
    if (response.headers['content-type']?.includes('application/json')) {
      const result = response.json<{ csrfToken?: string } | null>();
      if (result?.csrfToken) this.csrfToken = result.csrfToken;
    }
    return response;
  }

  login(handle: string, password = TEST_PASSWORD) {
    return this.request('POST', '/api/auth/login', { handle, password });
  }
}

/** Each fixture owns only a generated schema; no shared database is reset. */
export async function createApiFixture(
  options: {
    admission?: HttpAdmissionOptions;
    live?: LiveOptions;
    hooks?: ExchangeOptions['hooks'];
    origin?: string;
  } = {},
) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required.');
  const schema = `exchange_api_test_${randomUUID().replaceAll('-', '')}`;
  const owner = new pg.Pool({ connectionString });
  await owner.query(`CREATE SCHEMA "${schema}"`);
  const databaseUrl = new URL(connectionString);
  databaseUrl.searchParams.set(
    'options',
    `${databaseUrl.searchParams.get('options') ?? ''} -c search_path=${schema}`.trim(),
  );
  const url = databaseUrl.toString();
  const sql = new pg.Pool({ connectionString: url });
  let exchange: Exchange | undefined;
  let auth: AuthService | undefined;
  let app: Api | undefined;

  async function stop() {
    await app?.close();
    app = undefined;
    await exchange?.close();
    exchange = undefined;
  }

  async function start() {
    await stop();
    exchange = await Exchange.open(url, {
      allowFaultedStartup: true,
      ...(options.hooks ? { hooks: options.hooks } : {}),
    });
    auth = new AuthService(exchange);
    app = await buildApi({
      exchange,
      auth,
      origin: options.origin ?? API_ORIGIN,
      secureCookies: false,
      logger: false,
      ...(options.admission ? { admission: options.admission } : {}),
      ...(options.live ? { live: options.live } : {}),
    });
    await app.ready();
  }

  async function dispose() {
    try {
      await stop();
    } finally {
      await sql.end();
      try {
        await owner.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await owner.end();
      }
    }
  }

  try {
    await start();
    await auth!.bootstrapAdmin({ handle: 'operator', password: TEST_PASSWORD });
    const client = () =>
      new ApiClient(() => {
        if (!app) throw new Error('The API is stopped.');
        return app;
      }, options.origin);
    const admin = client();
    const login = await admin.login('operator');
    if (login.statusCode !== 200) throw new Error(`Bootstrap login failed (${login.statusCode}).`);
    const market = await admin.request('GET', '/api/market');
    const sessionId = market.json<{ sessionId: string }>().sessionId;
    return {
      sql,
      url,
      admin,
      sessionId,
      client,
      start,
      stop,
      dispose,
      async listen() {
        if (!app) throw new Error('The API is stopped.');
        return app.listen({ host: '127.0.0.1', port: 0 });
      },
      get httpServer() {
        if (!app) throw new Error('The API is stopped.');
        return app.server;
      },
      get exchange() {
        if (!exchange) throw new Error('The exchange is stopped.');
        return exchange;
      },
      get auth() {
        if (!auth) throw new Error('Authentication service is stopped.');
        return auth;
      },
      async invite() {
        const response = await admin.request('POST', '/api/admin/invitations', {
          commandId: randomUUID(),
          sessionId,
          reason: 'Create an isolated test participant',
        });
        if (response.statusCode !== 200) {
          throw new Error(`Invitation creation failed (${response.statusCode}).`);
        }
        const result = response.json<{ token: string; id?: string; data?: { id: string } }>();
        return { token: result.token, id: result.id ?? result.data!.id };
      },
      async trader(handle: string) {
        const invitation = await this.invite();
        const browser = client();
        const response = await browser.request('POST', '/api/auth/redeem', {
          token: invitation.token,
          handle,
          password: TEST_PASSWORD,
        });
        if (response.statusCode !== 200) {
          throw new Error(`Invitation redemption failed (${response.statusCode}).`);
        }
        const login = await browser.login(handle);
        if (login.statusCode !== 200) throw new Error(`Trader login failed (${login.statusCode}).`);
        const user = login.json<{ user: { accountId: string; handle: string; role: string } }>()
          .user;
        return { browser, user, invitation };
      },
      async marketState(state: 'pause' | 'resume') {
        return admin.request('POST', `/api/admin/market/${state}`, {
          commandId: randomUUID(),
          sessionId,
          reason: 'Exercise an explicit market transition',
        });
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export type ApiFixture = Awaited<ReturnType<typeof createApiFixture>>;
