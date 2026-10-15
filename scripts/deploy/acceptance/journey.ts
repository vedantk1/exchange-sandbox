import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { chromium, expect, type BrowserContext, type Download, type Page } from '@playwright/test';
import type {
  AccountView,
  PreparedHistoryExportView,
  WorkspaceView,
} from '../../../packages/contracts/src/index.js';
import { TrustedHttps } from './https.js';
import type { DiagnosticsSnapshot } from '../../../apps/server/src/diagnostics.js';

interface JourneyOptions {
  origin: string;
  /** PEM text, never a host trust-store modification. */
  ca: string;
  /** Base64 SHA-256 of this deployment's leaf certificate SPKI. */
  certificatePin: string;
  password: string;
  restartApi: () => Promise<void>;
  signal?: AbortSignal;
}

type Row = Record<string, string>;
type Files = Map<string, Row[]>;
interface Outcome {
  commandId: string;
  status: string;
  order?: { id: string; remaining: string; status: string };
  fills: { id: string; quantity: string; buyerFee: string; sellerFee: string }[];
}

function check(condition: unknown): asserts condition {
  if (!condition) throw new Error('ACCEPTANCE_ASSERTION_FAILED');
}

export class AcceptanceJourneyError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

/** Raw browser assertion failures can contain credentials or URLs. Never expose their causes. */
async function stage<T>(code: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AcceptanceJourneyError) throw error;
    throw new AcceptanceJourneyError(code);
  }
}

function client(
  context: BrowserContext,
  origin: string,
  ca: string,
  signal?: AbortSignal,
): TrustedHttps {
  return new TrustedHttps(
    origin,
    ca,
    async () => {
      const cookies = await context.cookies(origin);
      return {
        cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
        csrf: cookies.find(({ name }) => name === 'sandbox_csrf')?.value ?? '',
      };
    },
    signal,
  );
}

async function login(page: Page, options: JourneyOptions, handle: string): Promise<void> {
  const role = {
    acceptance_admin: 'ADMIN',
    acceptance_seller: 'SELLER',
    acceptance_buyer: 'BUYER',
  }[handle];
  check(role);
  await stage(`ACCEPTANCE_LOGIN_${role}_NAVIGATION_FAILED`, async () => {
    await page.goto(`${options.origin}/login`);
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
  await stage(`ACCEPTANCE_LOGIN_${role}_SUBMISSION_FAILED`, async () => {
    await page.getByLabel(/^Handle/).fill(handle);
    await page.getByLabel('Password', { exact: true }).fill(options.password);
    const [completed] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url() === `${options.origin}/api/auth/login` &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Sign in', exact: true }).click(),
    ]);
    check(completed.status() === 200);
  });
  await stage(`ACCEPTANCE_LOGIN_${role}_SYNC_FAILED`, async () => {
    await expect(page.getByText('Live · synced', { exact: true })).toBeVisible({ timeout: 15_000 });
  });
}

async function confirmAction(page: Page, reason: string): Promise<void> {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/^Reason/).fill(reason);
  await dialog.getByRole('button', { name: 'Confirm action', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

async function invite(
  admin: Page,
  trader: Page,
  options: JourneyOptions,
  handle: string,
): Promise<void> {
  const role = handle === 'acceptance_seller' ? 'SELLER' : 'BUYER';
  const invitation = await stage(`ACCEPTANCE_INVITATION_${role}_CREATION_FAILED`, async () => {
    await stage(`ACCEPTANCE_INVITATION_${role}_TAB_FAILED`, async () => {
      await admin
        .getByRole('navigation', { name: 'Administrator views', exact: true })
        .getByRole('button', { name: /^Invitations(?:\s*\d+)?$/ })
        .click();
    });
    await stage(`ACCEPTANCE_INVITATION_${role}_REVIEW_FAILED`, async () => {
      await admin.getByRole('button', { name: 'Create invitation', exact: true }).click();
      await expect(admin.getByRole('dialog')).toBeVisible();
    });
    await stage(`ACCEPTANCE_INVITATION_${role}_CONFIRM_FAILED`, async () => {
      const action = admin.getByRole('dialog');
      await action.getByLabel(/^Reason/).fill('Create isolated self-host acceptance participant');
      const [completed] = await Promise.all([
        admin.waitForResponse(
          (response) =>
            response.url() === `${options.origin}/api/admin/invitations` &&
            response.request().method() === 'POST',
        ),
        action.getByRole('button', { name: 'Confirm action', exact: true }).click(),
      ]);
      if (completed.status() !== 200) {
        const status = completed.status();
        throw new AcceptanceJourneyError(
          `ACCEPTANCE_INVITATION_${role}_HTTP_${status >= 100 && status <= 599 ? status : 'OTHER'}_FAILED`,
        );
      }
      const result = (await completed.json()) as { status?: unknown; token?: unknown };
      check(result.status === 'ACCEPTED' && typeof result.token === 'string');
    });
    await stage(`ACCEPTANCE_INVITATION_${role}_SECRET_READY_FAILED`, async () => {
      // Invitation confirmation immediately replaces the review with another dialog.
      await expect(
        admin.getByRole('heading', { name: 'Invitation ready', exact: true }),
      ).toBeVisible();
    });
    const link = await stage(`ACCEPTANCE_INVITATION_${role}_LINK_READ_FAILED`, async () => {
      const value = await admin.getByLabel('Single-use link', { exact: true }).inputValue();
      check(new URL(value).origin === options.origin);
      return value;
    });
    await stage(`ACCEPTANCE_INVITATION_${role}_SECRET_CLOSE_FAILED`, async () => {
      await admin.getByRole('button', { name: 'Close and discard link', exact: true }).click();
      await expect(admin.getByRole('dialog')).not.toBeVisible();
    });
    return link;
  });
  await stage(`ACCEPTANCE_INVITATION_${role}_NAVIGATION_FAILED`, async () => {
    await trader.goto(invitation);
    await expect(trader).toHaveURL(`${options.origin}/join`);
  });
  await stage(`ACCEPTANCE_INVITATION_${role}_REDEMPTION_FAILED`, async () => {
    await trader.getByLabel(/^Handle/).fill(handle);
    await trader.getByLabel('Password', { exact: true }).fill(options.password);
    await trader.getByLabel('Confirm password', { exact: true }).fill(options.password);
    const [completed] = await Promise.all([
      trader.waitForResponse(
        (response) =>
          response.url() === `${options.origin}/api/auth/redeem` &&
          response.request().method() === 'POST',
      ),
      trader.getByRole('button', { name: 'Create virtual trading account', exact: true }).click(),
    ]);
    check(completed.status() === 200);
    await expect(trader.getByRole('heading', { name: 'You’re ready to explore.' })).toBeVisible();
  });
  await login(trader, options, handle);
}

function csv(bytes: Buffer): Row[] {
  const text = bytes.toString('utf8');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (!quoted && char === ',') {
      row.push(field);
      field = '';
    } else if (!quoted && char === '\r' && text[index + 1] === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      index += 1;
    } else field += char;
  }
  check(!quoted && row.length === 0 && field === '');
  const columns = rows.shift();
  check(columns && new Set(columns).size === columns.length);
  return rows.map((values) => {
    check(values.length === columns.length);
    return Object.fromEntries(columns.map((key, index) => [key, values[index]!]));
  });
}

async function bytes(download: Download): Promise<Buffer> {
  const stream = await download.createReadStream();
  check(stream);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    check(size <= 1024 * 1024);
    chunks.push(buffer);
  }
  check((await download.failure()) === null);
  return Buffer.concat(chunks);
}

async function exported(
  page: Page,
  api: TrustedHttps,
  role: 'TRADER' | 'ADMIN',
): Promise<{ bundle: PreparedHistoryExportView; files: Files }> {
  let checkpoint = `ACCEPTANCE_EXPORT_${role}_PREPARE_FAILED`;
  try {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().startsWith(`${api.origin}/api/history/`) &&
          response.url().endsWith('/exports') &&
          response.request().method() === 'POST',
      ),
      page.getByRole('button', { name: 'Export consistent CSV', exact: true }).click(),
    ]);
    if (response.status() !== 200) {
      const status = response.status();
      throw new AcceptanceJourneyError(
        `ACCEPTANCE_EXPORT_${role}_HTTP_${status >= 100 && status <= 599 ? status : 'OTHER'}_FAILED`,
      );
    }
    const bundle = (await response.json()) as PreparedHistoryExportView;
    checkpoint = `ACCEPTANCE_EXPORT_${role}_DIALOG_FAILED`;
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Consistent history export' })).toBeVisible();
    const files: Files = new Map();
    for (const file of bundle.files) {
      const category = {
        'manifest.csv': 'MANIFEST',
        'orders.csv': 'ORDERS',
        'fills.csv': 'FILLS',
        'activity.csv': 'ACTIVITY',
        'commands.csv': 'COMMANDS',
        'balances.csv': 'BALANCES',
        'audit.csv': 'AUDIT',
      }[file.name];
      check(category);
      checkpoint = `ACCEPTANCE_EXPORT_${role}_${category}_DOWNLOAD_FAILED`;
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('link', { name: file.name, exact: true }).click(),
      ]);
      check(download.suggestedFilename() === file.name);
      const content = await bytes(download);
      checkpoint = `ACCEPTANCE_EXPORT_${role}_${category}_HASH_FAILED`;
      check(content.length === file.bytes);
      check(createHash('sha256').update(content).digest('hex') === file.sha256);
      checkpoint = `ACCEPTANCE_EXPORT_${role}_${category}_CSV_FAILED`;
      const rows = csv(content);
      check(rows.length === file.rows);
      files.set(file.name, rows);
      // A second trusted Node TLS request verifies real attachment headers and URL scope.
      checkpoint = `ACCEPTANCE_EXPORT_${role}_${category}_HEADERS_FAILED`;
      const headers = await api.response('GET', file.downloadUrl);
      check(
        headers.status === 200 && headers.headers['content-type'] === 'text/csv; charset=utf-8',
      );
      check(headers.headers['content-disposition'] === `attachment; filename="${file.name}"`);
      check(headers.headers['content-length'] === String(file.bytes));
      check(headers.bytes.equals(content));
    }
    checkpoint = `ACCEPTANCE_EXPORT_${role}_MANIFEST_FAILED`;
    check(files.size === bundle.files.length);
    check(files.get('manifest.csv')?.length === 1);
    const [manifest] = files.get('manifest.csv')!;
    check(manifest);
    check(
      manifest.sessionId === bundle.sessionId && manifest.accountId === (bundle.accountId ?? ''),
    );
    check(manifest.asOf === bundle.asOf && manifest.outboxCursor === bundle.cursor);
    check(manifest.auditScope === bundle.auditScope);
    check(manifest.scope === (bundle.accountId ? 'ACCOUNT' : 'ADMIN_SESSION'));
    check(manifest.baseAsset === 'BTC-SIM' && manifest.quoteAsset === 'USD-SIM');
    return { bundle, files };
  } catch (error) {
    if (error instanceof AcceptanceJourneyError) throw error;
    throw new AcceptanceJourneyError(checkpoint);
  }
}

function units(value: string, decimals: number): bigint {
  check(/^-?[0-9]+(?:\.[0-9]+)?$/.test(value));
  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
  check(fraction.length <= decimals);
  const amount = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`);
  return negative ? -amount : amount;
}

function balances(account: AccountView | undefined, btc: string, usd: string): void {
  check(
    account &&
      account.openOrders.length === 0 &&
      account.orders.length === 1 &&
      account.fills.length === 1,
  );
  check(account.balances['BTC-SIM'].available === btc && account.balances['BTC-SIM'].total === btc);
  check(account.balances['BTC-SIM'].reserved === '0.0000');
  check(account.balances['USD-SIM'].available === usd && account.balances['USD-SIM'].total === usd);
  check(account.balances['USD-SIM'].reserved === '0.000000000');
}

function accountExport(
  files: Files,
  accountId: string,
  otherAccountId: string,
  btc: string,
  usd: string,
): void {
  check(
    isDeepStrictEqual(
      [...files.keys()],
      ['manifest.csv', 'orders.csv', 'fills.csv', 'activity.csv', 'commands.csv', 'balances.csv'],
    ),
  );
  const rows = files.get('balances.csv')!;
  check(rows.length === 2 && rows.every((row) => row.accountId === accountId));
  for (const [asset, expected] of [
    ['BTC-SIM', btc],
    ['USD-SIM', usd],
  ]) {
    const row = rows.find((row) => row.asset === asset);
    check(row && row.available === expected && row.total === expected);
    check(units(row.reserved!, asset === 'BTC-SIM' ? 4 : 9) === 0n);
    const sum = files
      .get('activity.csv')!
      .filter((entry) => entry.asset === asset)
      .reduce((total, entry) => total + units(entry.amount!, asset === 'BTC-SIM' ? 4 : 9), 0n);
    check(sum === units(expected!, asset === 'BTC-SIM' ? 4 : 9));
  }
  const fill = files.get('fills.csv')!;
  check(fill.length === 1 && fill[0]!.quantity === '0.1000' && fill[0]!.fee === '5.000000000');
  check(!('buyOrderId' in fill[0]!) && !('sellOrderId' in fill[0]!));
  check(!JSON.stringify([...files.values()]).includes(otherAccountId));
}

/** Compiled React UI, authenticated HTTPS endpoints and Caddy SSE; no fixture or owner-DB access. */
export async function runJourney(options: JourneyOptions): Promise<Record<string, boolean>> {
  const browser = await stage('ACCEPTANCE_BROWSER_FAILED', () =>
    chromium.launch({
      headless: true,
      timeout: 15_000,
      args: [`--ignore-certificate-errors-spki-list=${options.certificatePin}`],
    }),
  );
  let events: Awaited<ReturnType<TrustedHttps['events']>> | undefined;
  const abort = () => {
    events?.close();
    void browser.close().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    if (options.signal?.aborted) throw new AcceptanceJourneyError('ACCEPTANCE_INTERRUPTED');
    const contexts = await Promise.all([
      browser.newContext({ acceptDownloads: true }),
      browser.newContext({ acceptDownloads: true }),
      browser.newContext({ acceptDownloads: true }),
    ]);
    const [adminContext, sellerContext, buyerContext] = contexts as [
      BrowserContext,
      BrowserContext,
      BrowserContext,
    ];
    const [admin, seller, buyer] = await Promise.all(contexts.map((context) => context.newPage()));
    check(admin && seller && buyer);
    for (const page of [admin, seller, buyer]) {
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(15_000);
    }
    const operator = client(adminContext, options.origin, options.ca, options.signal);
    const sellApi = client(sellerContext, options.origin, options.ca, options.signal);
    const buyApi = client(buyerContext, options.origin, options.ca, options.signal);
    await stage('ACCEPTANCE_LOGIN_FAILED', async () => {
      await login(admin, options, 'acceptance_admin');
      await invite(admin, seller, options, 'acceptance_seller');
      await invite(admin, buyer, options, 'acceptance_buyer');
      await stage('ACCEPTANCE_SECURE_SESSION_COOKIES_FAILED', async () => {
        for (const context of contexts) {
          const cookies = await context.cookies(options.origin);
          const session = cookies.find(({ name }) => name === 'sandbox_session');
          const csrf = cookies.find(({ name }) => name === 'sandbox_csrf');
          check(session?.secure && session.httpOnly && session.sameSite === 'Strict');
          check(csrf?.secure && !csrf.httpOnly && csrf.sameSite === 'Strict');
        }
      });
    });
    const initial = await stage('ACCEPTANCE_TRADING_FAILED', async () => {
      let checkpoint = 'ACCEPTANCE_TRADING_INITIAL_WORKSPACE_FAILED';
      try {
        const workspace = await operator.json<WorkspaceView>('GET', '/api/workspace');
        check(
          workspace.marketState === 'PAUSED' &&
            workspace.admin &&
            (workspace.admin.overview.demoMarket === undefined ||
              workspace.admin.overview.demoMarket.enabled === false),
        );
        checkpoint = 'ACCEPTANCE_TRADING_CSRF_FAILED';
        const csrf = await operator.response(
          'POST',
          '/api/admin/market/resume',
          {
            commandId: randomUUID(),
            sessionId: workspace.sessionId,
            reason: 'Verify CSRF rejection',
          },
          false,
        );
        check(
          csrf.status === 403 && JSON.parse(csrf.bytes.toString('utf8')).code === 'CSRF_INVALID',
        );
        checkpoint = 'ACCEPTANCE_TRADING_RESUME_FAILED';
        await admin
          .getByRole('navigation', { name: 'Administrator views', exact: true })
          .getByRole('button', { name: 'Overview', exact: true })
          .click();
        await admin.getByRole('button', { name: 'Resume trading', exact: true }).click();
        await confirmAction(admin, 'Enable isolated self-host acceptance trading');
        checkpoint = 'ACCEPTANCE_TRADING_SELLER_PLACE_FAILED';
        await expect(seller.getByText('Live · synced', { exact: true })).toBeVisible();
        await expect(
          seller.getByRole('button', { name: 'Review sell order', exact: true }),
        ).toHaveCount(0);
        await seller.getByRole('button', { name: 'Sell', exact: true }).click();
        await seller.getByLabel(/^Limit price/).fill('50000');
        await seller.getByLabel(/^Quantity/).fill('0.4');
        await seller.getByRole('button', { name: 'Review sell order', exact: true }).click();
        await seller.getByRole('button', { name: 'Confirm sell order', exact: true }).click();
        const order = seller
          .getByRole('row')
          .filter({ has: seller.getByRole('button', { name: 'Cancel', exact: true }) });
        await expect(order).toContainText('Open');
        const before = await sellApi.json<WorkspaceView>('GET', '/api/workspace');
        check(before.account?.orders.length === 1);
        checkpoint = 'ACCEPTANCE_TRADING_SSE_READY_FAILED';
        events = await sellApi.events(
          `/api/events?sessionId=${before.sessionId}&cursor=${before.cursor}`,
        );
        await events.wait('ready');
        const command = {
          commandId: randomUUID(),
          sessionId: before.sessionId,
          side: 'BUY',
          quantity: '0.1',
          price: '50000',
        };
        checkpoint = 'ACCEPTANCE_TRADING_MATCH_FAILED';
        const receipt = await buyApi.json<Outcome>('POST', '/api/orders', command);
        check(
          receipt.status === 'ACCEPTED' &&
            receipt.fills.length === 1 &&
            receipt.order?.status === 'FILLED',
        );
        check(
          receipt.fills[0]!.quantity === '0.1000' &&
            receipt.fills[0]!.buyerFee === '5.000000000' &&
            receipt.fills[0]!.sellerFee === '5.000000000',
        );
        checkpoint = 'ACCEPTANCE_TRADING_PARTIAL_FILL_FAILED';
        await events.wait('invalidate');
        await expect(order).toContainText('Partially Filled');
        await expect(order).toContainText('0.1000');
        const partial = await sellApi.json<WorkspaceView>('GET', '/api/workspace');
        check(partial.account?.orders[0]?.remaining === '0.3000');
        await expect(seller.getByRole('region', { name: 'Available balances' })).toContainText(
          '0.3000 reserved',
        );
        checkpoint = 'ACCEPTANCE_TRADING_CANCEL_FAILED';
        await order.getByRole('button', { name: 'Cancel', exact: true }).click();
        await seller.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
        await expect(seller.getByRole('dialog')).toContainText('Earlier fills are preserved');
        await seller
          .getByRole('dialog')
          .getByRole('button', { name: 'Close', exact: true })
          .click();
        checkpoint = 'ACCEPTANCE_TRADING_FINAL_BALANCES_FAILED';
        await expect(seller.getByRole('region', { name: 'Available balances' })).toContainText(
          '104,995.00',
        );
        await expect(buyer.getByRole('region', { name: 'Available balances' })).toContainText(
          '94,995.00',
        );
        const sold = await sellApi.json<WorkspaceView>('GET', '/api/workspace');
        const bought = await buyApi.json<WorkspaceView>('GET', '/api/workspace');
        balances(sold.account, '0.9000', '104995.000000000');
        balances(bought.account, '1.1000', '94995.000000000');
        check(
          sold.account!.orders[0]!.status === 'CANCELED' &&
            sold.account!.orders[0]!.remaining === '0.3000',
        );
        return { command, receipt, sold, bought };
      } catch (error) {
        if (error instanceof AcceptanceJourneyError) throw error;
        throw new AcceptanceJourneyError(checkpoint);
      }
    });
    await stage('ACCEPTANCE_EXPORTS_FAILED', async () => {
      let checkpoint = 'ACCEPTANCE_EXPORT_TRADER_NAVIGATION_FAILED';
      try {
        await seller
          .getByRole('navigation', { name: 'Workspace navigation' })
          .getByRole('link', { name: 'History', exact: true })
          .click();
        const own = await exported(seller, sellApi, 'TRADER');
        checkpoint = 'ACCEPTANCE_EXPORT_TRADER_RECONCILIATION_FAILED';
        check(
          own.bundle.accountId === initial.sold.user.accountId && own.bundle.auditScope === 'NONE',
        );
        accountExport(
          own.files,
          initial.sold.user.accountId,
          initial.bought.user.accountId,
          '0.9000',
          '104995.000000000',
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ACCOUNT_PRIVACY_FAILED';
        const denied = await buyApi.response(
          'POST',
          `/api/history/${initial.sold.sessionId}/exports`,
          { accountId: initial.sold.user.accountId },
        );
        check(denied.status === 403);
        for (const file of own.bundle.files)
          check((await buyApi.response('GET', file.downloadUrl)).status === 403);
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_NAVIGATION_FAILED';
        await admin
          .getByRole('navigation', { name: 'Administrator views', exact: true })
          .getByRole('button', { name: 'Sessions & history', exact: true })
          .click();
        const all = await exported(admin, operator, 'ADMIN');
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_SCOPE_FAILED';
        check(all.bundle.accountId === null && all.bundle.auditScope === 'SESSION');
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_FILENAMES_FAILED';
        check(
          isDeepStrictEqual(
            [...all.files.keys()],
            [
              'manifest.csv',
              'orders.csv',
              'fills.csv',
              'activity.csv',
              'commands.csv',
              'balances.csv',
              'audit.csv',
            ],
          ),
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_BUYER_RECEIPT_FAILED';
        const buyerCommands = all.files
          .get('commands.csv')!
          .filter((row) => row.commandId === initial.command.commandId);
        check(
          buyerCommands.length === 1 &&
            buyerCommands[0]!.status === 'ACCEPTED' &&
            buyerCommands[0]!.orderId === initial.receipt.order!.id,
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_SELLER_RECEIPTS_FAILED';
        const sellerCommands = all.files
          .get('commands.csv')!
          .filter((row) => row.accountId === initial.sold.user.accountId && row.orderId !== '');
        check(
          sellerCommands.length === 2 &&
            sellerCommands.every(
              (row) =>
                row.status === 'ACCEPTED' && row.orderId === initial.sold.account!.orders[0]!.id,
            ),
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_RECORD_COUNTS_FAILED';
        check(
          all.files.get('orders.csv')?.length === 2 && all.files.get('fills.csv')?.length === 1,
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_AUDIT_COUNT_FAILED';
        check((all.files.get('audit.csv')?.length ?? 0) >= 3);
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_FILL_IDENTITIES_FAILED';
        const fill = all.files.get('fills.csv')![0]!;
        check(
          fill.buyerAccountId === initial.bought.user.accountId &&
            fill.sellerAccountId === initial.sold.user.accountId,
        );
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_FILL_FEES_FAILED';
        check(
          fill.quantity === '0.1000' &&
            fill.buyerFee === '5.000000000' &&
            fill.sellerFee === '5.000000000',
        );
        const allBalances = all.files.get('balances.csv')!;
        for (const [asset, decimals] of [
          ['BTC-SIM', 4],
          ['USD-SIM', 9],
        ] as const) {
          const assetCode = asset === 'BTC-SIM' ? 'BTC' : 'USD';
          checkpoint = `ACCEPTANCE_EXPORT_ADMIN_${assetCode}_BALANCE_COUNT_FAILED`;
          const assetBalances = allBalances.filter((row) => row.asset === asset);
          check(assetBalances.length >= 4);
          checkpoint = `ACCEPTANCE_EXPORT_ADMIN_${assetCode}_CONSERVATION_FAILED`;
          check(
            assetBalances.reduce((total, row) => total + units(row.total!, decimals), 0n) === 0n,
          );
          checkpoint = `ACCEPTANCE_EXPORT_ADMIN_${assetCode}_BUCKET_TOTALS_FAILED`;
          check(
            assetBalances.every(
              (row) =>
                units(row.available!, decimals) + units(row.reserved!, decimals) ===
                units(row.total!, decimals),
            ),
          );
          checkpoint = `ACCEPTANCE_EXPORT_ADMIN_${assetCode}_ACTIVITY_SUM_FAILED`;
          const activity = all.files.get('activity.csv')!.filter((row) => row.asset === asset);
          check(activity.reduce((total, row) => total + units(row.amount!, decimals), 0n) === 0n);
          checkpoint = `ACCEPTANCE_EXPORT_ADMIN_${assetCode}_ACCOUNT_SUM_FAILED`;
          for (const balance of assetBalances)
            check(
              activity
                .filter((row) => row.accountId === balance.accountId)
                .reduce((total, row) => total + units(row.amount!, decimals), 0n) ===
                units(balance.total!, decimals),
            );
        }
        checkpoint = 'ACCEPTANCE_EXPORT_ADMIN_FEE_ACCOUNT_FAILED';
        const feeAccount = (await operator.json<WorkspaceView>('GET', '/api/workspace')).admin!
          .overview.feeAccountId;
        check(
          allBalances.find((row) => row.accountId === feeAccount && row.asset === 'USD-SIM')
            ?.total === '10.000000000',
        );
        checkpoint = 'ACCEPTANCE_EXPORT_DIALOG_CLOSE_FAILED';
        await admin.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
        await seller.getByRole('dialog').getByRole('button', { name: 'Done', exact: true }).click();
      } catch (error) {
        if (error instanceof AcceptanceJourneyError) throw error;
        throw new AcceptanceJourneyError(checkpoint);
      }
    });
    const diagnosticsBeforeRestart = await stage('ACCEPTANCE_DIAGNOSTICS_FAILED', () =>
      operator.json<DiagnosticsSnapshot>('GET', '/api/admin/diagnostics'),
    );
    await stage('ACCEPTANCE_RESTART_FAILED', async () => {
      events?.close();
      events = undefined;
      const cookieBefore = (await buyerContext.cookies(options.origin)).find(
        ({ name }) => name === 'sandbox_session',
      )!.value;
      await options.restartApi();
      const session = await buyApi.json<{ user: WorkspaceView['user'] }>(
        'GET',
        '/api/auth/session',
      );
      check(session.user.accountId === initial.bought.user.accountId);
      check(
        (await buyerContext.cookies(options.origin)).find(({ name }) => name === 'sandbox_session')!
          .value === cookieBefore,
      );
      const original = await buyApi.json<Outcome>(
        'GET',
        `/api/receipts/${initial.command.commandId}`,
      );
      check(isDeepStrictEqual(original, initial.receipt));
      const replay = await buyApi.json<Outcome>('POST', '/api/orders', initial.command);
      check(isDeepStrictEqual(replay, initial.receipt));
      const sold = await sellApi.json<WorkspaceView>('GET', '/api/workspace');
      const bought = await buyApi.json<WorkspaceView>('GET', '/api/workspace');
      check(
        isDeepStrictEqual(sold.account, initial.sold.account) &&
          isDeepStrictEqual(bought.account, initial.bought.account),
      );
      await stage('ACCEPTANCE_RESTART_AUTOMATIC_RESYNC_FAILED', async () => {
        events = await buyApi.events(
          `/api/events?sessionId=${bought.sessionId}&cursor=${bought.cursor}`,
        );
        await events.wait('ready');
        const paused = await operator.json<{ status: string }>('POST', '/api/admin/market/pause', {
          commandId: randomUUID(),
          sessionId: bought.sessionId,
          reason: 'Verify automatic browser resynchronization after API restart',
        });
        check(paused.status === 'ACCEPTED');
        await events.wait('invalidate');
        // No navigation, refresh button or reload: the existing UI must reconnect and consume the new event.
        await expect(buyer.getByText('Trading is paused.', { exact: false })).toBeVisible({
          timeout: 15_000,
        });
        await expect(buyer.getByText('Live · synced', { exact: true })).toBeVisible({
          timeout: 15_000,
        });
      });
      await buyer.reload();
      await expect(buyer.getByText('Live · synced', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(buyer.getByRole('region', { name: 'Available balances' })).toContainText(
        '94,995.00',
      );
      await seller
        .getByRole('navigation', { name: 'Workspace navigation' })
        .getByRole('link', { name: 'Orders', exact: true })
        .click();
      await expect(seller.getByRole('row').filter({ hasText: 'Canceled' })).toContainText('0.1000');
    });
    await stage('ACCEPTANCE_DIAGNOSTICS_FAILED', async () => {
      const diagnostics = await operator.json<DiagnosticsSnapshot>('GET', '/api/admin/diagnostics');
      check((await buyApi.response('GET', '/api/admin/diagnostics')).status === 403);
      check(diagnostics.schemaVersion === 1 && diagnostics.histogramSemantics === 'cumulative');
      check(Date.parse(diagnostics.startedAt) > Date.parse(diagnosticsBeforeRestart.startedAt));
      check(diagnostics.timings['engine.command'].count >= 1);
      check(diagnostics.timings['engine.lock'].count > 0);
      check(diagnostics.events['command.replayed'] >= 1);
      check(
        diagnostics.gauges['engine.available'] === 1 && diagnostics.gauges['engine.faulted'] === 0,
      );
      check(diagnostics.gauges['live.connections'] > 0);
      const serialized = JSON.stringify(diagnostics);
      for (const privateValue of [
        options.password,
        initial.command.commandId,
        initial.bought.user.accountId,
        initial.sold.user.accountId,
      ])
        check(!serialized.includes(privateValue));
    });
    return {
      compiledUiLogin: true,
      invitationRedemption: true,
      csrfProtection: true,
      secureSessionCookies: true,
      partialFillAndCancellation: true,
      liveUpdates: true,
      traderExportReconciliation: true,
      adminExportReconciliation: true,
      crossAccountExportDenied: true,
      sessionPreservedAfterRestart: true,
      originalReceiptReplay: true,
      restartAccountingPreserved: true,
      operationalDiagnostics: true,
    };
  } catch (error) {
    if (error instanceof AcceptanceJourneyError) throw error;
    throw new AcceptanceJourneyError('ACCEPTANCE_BROWSER_FAILED');
  } finally {
    options.signal?.removeEventListener('abort', abort);
    events?.close();
    await stage('ACCEPTANCE_BROWSER_CLEANUP_FAILED', () => browser.close());
  }
}
