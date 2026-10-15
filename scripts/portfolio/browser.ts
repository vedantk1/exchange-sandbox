import { access } from 'node:fs/promises';
import { chromium, expect, type Browser, type Page } from '@playwright/test';
import { PortfolioError } from './options.js';

/** Transfer only cookies issued by real authentication in the owned fixture. */
export function demoCookies(header: string, origin: string) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/')
    throw new PortfolioError('PORTFOLIO_AUTHENTICATION_INVALID');
  const pairs = header.split('; ').map((pair) => {
    const boundary = pair.indexOf('=');
    return [pair.slice(0, boundary), pair.slice(boundary + 1)] as const;
  });
  if (
    pairs.length !== 2 ||
    !['sandbox_session', 'sandbox_csrf'].every(
      (name) => pairs.filter(([key, value]) => key === name && value.length > 0).length === 1,
    )
  )
    throw new PortfolioError('PORTFOLIO_AUTHENTICATION_INVALID');
  return pairs.map(([name, value]) => ({
    name,
    value,
    domain: '127.0.0.1',
    path: '/',
    expires: -1,
    httpOnly: name === 'sandbox_session',
    secure: false,
    sameSite: 'Strict' as const,
  }));
}

export interface DemoBrowser {
  trader: Page;
  admin: Page;
  close(): Promise<void>;
}

interface BrowserDependencies {
  installed(): Promise<void>;
  launch(headless: boolean): Promise<Browser>;
  ready(page: Page): Promise<void>;
}

const browserDependencies: BrowserDependencies = {
  installed: () => access(chromium.executablePath()),
  launch: (headless) => chromium.launch({ headless, timeout: 15_000 }),
  ready: async (page) => {
    await expect(page.getByText('Live · synced', { exact: true })).toBeVisible({
      timeout: 15_000,
    });
  },
};

/** Each role owns an isolated context; no capabilities are written to disk. */
export async function openDemoBrowser(
  options: {
    origin: string;
    traderCookie: string;
    adminCookie: string;
    headless: boolean;
    signal: AbortSignal;
    onClose(): void;
  },
  dependencies: BrowserDependencies = browserDependencies,
): Promise<DemoBrowser> {
  const traderCookies = demoCookies(options.traderCookie, options.origin);
  const adminCookies = demoCookies(options.adminCookie, options.origin);
  options.signal.throwIfAborted();
  try {
    await dependencies.installed();
  } catch {
    throw new PortfolioError('PORTFOLIO_BROWSER_NOT_INSTALLED');
  }
  let browser: Browser;
  try {
    browser = await dependencies.launch(options.headless);
  } catch {
    throw new PortfolioError('PORTFOLIO_BROWSER_LAUNCH_FAILED');
  }
  const pages: Page[] = [];
  let closing: Promise<void> | undefined;
  let notified = false;
  let ready = false;
  const closed = () => {
    if (!closing && !notified) {
      notified = true;
      options.onClose();
    }
  };
  // A closed role window is intentional cleanup even while the other starts.
  // A transport loss before startup completes remains a startup failure.
  const disconnected = () => {
    if (ready) closed();
  };
  const close = () => {
    if (!closing) {
      options.signal.removeEventListener('abort', aborted);
      browser.off('disconnected', disconnected);
      for (const page of pages) page.off('close', closed);
      closing = browser.close();
    }
    return closing;
  };
  const aborted = () => {
    void close().catch(() => undefined);
  };
  browser.on('disconnected', disconnected);
  options.signal.addEventListener('abort', aborted, { once: true });
  try {
    options.signal.throwIfAborted();
    for (const [cookies, path] of [
      [traderCookies, '/trade'],
      [adminCookies, '/admin'],
    ] as const) {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        serviceWorkers: 'block',
      });
      await context.addCookies(cookies);
      const page = await context.newPage();
      pages.push(page);
      page.on('close', closed);
      page.setDefaultTimeout(12_000);
      page.setDefaultNavigationTimeout(15_000);
      await page.goto(`${options.origin}${path}`);
      await dependencies.ready(page);
      options.signal.throwIfAborted();
      if (notified) throw new PortfolioError('PORTFOLIO_BROWSER_START_FAILED');
    }
    ready = true;
    return { trader: pages[0]!, admin: pages[1]!, close };
  } catch {
    try {
      await close();
    } finally {
      throw new PortfolioError('PORTFOLIO_BROWSER_START_FAILED');
    }
  }
}
