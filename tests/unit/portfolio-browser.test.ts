import { EventEmitter } from 'node:events';
import type { Browser, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { demoCookies, openDemoBrowser } from '../../scripts/portfolio/browser.js';
import { portfolioOptions } from '../../scripts/portfolio/options.js';

const origin = 'http://127.0.0.1:43210';
const traderCookie = 'sandbox_session=trader-capability; sandbox_csrf=trader-csrf';
const adminCookie = 'sandbox_session=admin-capability; sandbox_csrf=admin-csrf';

function fakeBrowser() {
  const pages: Array<EventEmitter & { goto: ReturnType<typeof vi.fn> }> = [];
  const contexts: Array<{
    addCookies: ReturnType<typeof vi.fn>;
    newPage: ReturnType<typeof vi.fn>;
  }> = [];
  const browser = Object.assign(new EventEmitter(), {
    close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => {
      const page = Object.assign(new EventEmitter(), {
        goto: vi.fn(async () => undefined),
        setDefaultTimeout: vi.fn(),
        setDefaultNavigationTimeout: vi.fn(),
      });
      pages.push(page);
      const context = {
        addCookies: vi.fn(async () => undefined),
        newPage: vi.fn(async () => page as unknown as Page),
      };
      contexts.push(context);
      return context;
    }),
  });
  const dependencies = {
    installed: vi.fn(async () => undefined),
    launch: vi.fn(async () => browser as unknown as Browser),
    ready: vi.fn(async () => undefined),
  };
  const controller = new AbortController();
  const options = {
    origin,
    traderCookie,
    adminCookie,
    headless: false,
    signal: controller.signal,
    onClose: vi.fn(),
  };
  return { browser, pages, contexts, dependencies, controller, options };
}

describe('reviewer demonstration options', () => {
  it('opens the browser by default and makes capture capabilities an explicit option', () => {
    expect(portfolioOptions([])).toEqual({ headless: false, smoke: false, noOpen: false });
    expect(portfolioOptions(['--headless', '--smoke'])).toEqual({
      headless: true,
      smoke: true,
      noOpen: false,
    });
    expect(portfolioOptions(['--no-open'])).toEqual({
      headless: false,
      smoke: false,
      noOpen: true,
    });
  });

  it.each([
    ['--headless'],
    ['--smoke'],
    ['--no-open', '--headless', '--smoke'],
    ['--no-open', '--no-open'],
    ['--unknown-private-value'],
  ])('rejects unsupported or ambiguous flags without echoing them: %j', (...flags) => {
    expect(() => portfolioOptions(flags)).toThrow('PORTFOLIO_ARGUMENTS_INVALID');
  });
});

describe('isolated reviewer browser lifecycle', () => {
  it('keeps genuine trader and administrator capabilities in separate contexts', async () => {
    const fake = fakeBrowser();
    const result = await openDemoBrowser(fake.options, fake.dependencies);
    expect(fake.dependencies.launch).toHaveBeenCalledWith(false);
    expect(fake.contexts).toHaveLength(2);
    expect(fake.contexts[0]!.addCookies).toHaveBeenCalledWith(demoCookies(traderCookie, origin));
    expect(fake.contexts[1]!.addCookies).toHaveBeenCalledWith(demoCookies(adminCookie, origin));
    expect(fake.pages[0]!.goto).toHaveBeenCalledWith(`${origin}/trade`);
    expect(fake.pages[1]!.goto).toHaveBeenCalledWith(`${origin}/admin`);
    expect(fake.dependencies.ready).toHaveBeenCalledTimes(2);
    await result.close();
    await result.close();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.options.onClose).not.toHaveBeenCalled();
    expect(fake.browser.listenerCount('disconnected')).toBe(0);
    expect(fake.pages.every((page) => page.listenerCount('close') === 0)).toBe(true);
  });

  it('closing either role window signals one cleanup request', async () => {
    const fake = fakeBrowser();
    const result = await openDemoBrowser(fake.options, fake.dependencies);
    fake.pages[1]!.emit('close');
    fake.pages[0]!.emit('close');
    fake.browser.emit('disconnected');
    expect(fake.options.onClose).toHaveBeenCalledTimes(1);
    await result.close();
  });

  it('closes the browser and removes listeners on interruption', async () => {
    const fake = fakeBrowser();
    const result = await openDemoBrowser(fake.options, fake.dependencies);
    fake.controller.abort();
    await result.close();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.options.onClose).not.toHaveBeenCalled();
    expect(fake.pages.every((page) => page.listenerCount('close') === 0)).toBe(true);
  });

  it('honors closing the trader while the administrator window is still starting', async () => {
    const fake = fakeBrowser();
    fake.options.onClose.mockImplementation(() => fake.controller.abort());
    fake.dependencies.ready
      .mockImplementationOnce(async () => undefined)
      .mockImplementationOnce(async () => {
        fake.pages[0]!.emit('close');
        expect(fake.controller.signal.aborted).toBe(true);
        expect(fake.browser.close).toHaveBeenCalledTimes(1);
      });
    await expect(openDemoBrowser(fake.options, fake.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_START_FAILED',
    );
    expect(fake.options.onClose).toHaveBeenCalledTimes(1);
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.browser.listenerCount('disconnected')).toBe(0);
    expect(fake.pages.every((page) => page.listenerCount('close') === 0)).toBe(true);
  });

  it('does not turn a startup transport failure into an intentional window close', async () => {
    const fake = fakeBrowser();
    fake.dependencies.ready.mockImplementationOnce(async () => {
      fake.browser.emit('disconnected');
      throw new Error('private startup transport exception');
    });
    await expect(openDemoBrowser(fake.options, fake.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_START_FAILED',
    );
    expect(fake.options.onClose).not.toHaveBeenCalled();
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes a partly opened browser when a second context cannot start', async () => {
    const fake = fakeBrowser();
    const firstContext = fake.browser.newContext.getMockImplementation()!;
    fake.browser.newContext
      .mockImplementationOnce(firstContext)
      .mockRejectedValueOnce(new Error('private context exception'));
    await expect(openDemoBrowser(fake.options, fake.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_START_FAILED',
    );
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.contexts).toHaveLength(1);
    expect(fake.pages[0]!.listenerCount('close')).toBe(0);
    expect(fake.browser.listenerCount('disconnected')).toBe(0);
    expect(fake.options.onClose).not.toHaveBeenCalled();
  });

  it('closes a launched browser when interrupted during launch before navigation', async () => {
    const fake = fakeBrowser();
    fake.dependencies.launch.mockImplementationOnce(async () => {
      fake.controller.abort();
      return fake.browser as unknown as Browser;
    });
    await expect(openDemoBrowser(fake.options, fake.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_START_FAILED',
    );
    expect(fake.browser.close).toHaveBeenCalledTimes(1);
    expect(fake.browser.newContext).not.toHaveBeenCalled();
  });

  it('classifies an absent browser and launch failures without leaking raw diagnostics', async () => {
    const missing = fakeBrowser();
    missing.dependencies.installed.mockRejectedValueOnce(new Error('private executable path'));
    await expect(openDemoBrowser(missing.options, missing.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_NOT_INSTALLED',
    );
    expect(missing.dependencies.launch).not.toHaveBeenCalled();
    const failed = fakeBrowser();
    failed.dependencies.launch.mockRejectedValueOnce(new Error('private display environment'));
    await expect(openDemoBrowser(failed.options, failed.dependencies)).rejects.toThrow(
      'PORTFOLIO_BROWSER_LAUNCH_FAILED',
    );
  });

  it('rejects unknown cookies and non-loopback destinations before opening a browser', async () => {
    for (const options of [
      { traderCookie: `${traderCookie}; other=capability` },
      { traderCookie: 'sandbox_session=one; sandbox_session=two' },
      { origin: 'http://example.test' },
      { origin: `${origin}/another-path` },
    ]) {
      const fake = fakeBrowser();
      await expect(
        openDemoBrowser({ ...fake.options, ...options }, fake.dependencies),
      ).rejects.toThrow('PORTFOLIO_AUTHENTICATION_INVALID');
      expect(fake.dependencies.installed).not.toHaveBeenCalled();
    }
    expect(demoCookies(traderCookie, origin)).toMatchObject([
      { name: 'sandbox_session', httpOnly: true, sameSite: 'Strict', secure: false },
      { name: 'sandbox_csrf', httpOnly: false, sameSite: 'Strict', secure: false },
    ]);
  });
});
