import { randomUUID } from 'node:crypto';
import type { CommandResult } from '../../apps/server/src/types.js';
import type { HistoryView, WorkspaceView } from '../../packages/contracts/src/index.js';
import { test, expect, login } from './fixtures.js';
import type { ApiFixture } from '../helpers/api.js';

async function archive(application: { api: ApiFixture }) {
  const trader = await application.api.trader('history_reader');
  await application.api.marketState('resume');
  const placed = await trader.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'SELL',
    quantity: '0.1',
    price: '50000',
  });
  const order = placed.json<CommandResult>().order!;
  await application.api.marketState('pause');
  const rolled = await application.api.admin.request('POST', '/api/admin/sessions/rollover', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    reason: 'Inspect an immutable archive while the new session runs',
  });
  expect(rolled.json()).toMatchObject({ status: 'ACCEPTED' });
  const current = (await trader.browser.request('GET', '/api/workspace')).json<WorkspaceView>();
  return { trader, order, current };
}

test('history restores archive and filters through reload and browser Back/Forward', async ({
  page,
  application,
}) => {
  const { order } = await archive(application);
  await login(page, application.origin, 'history_reader');
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'History', exact: true })
    .click();
  await page.getByLabel('Trading session', { exact: true }).selectOption(application.api.sessionId);
  const views = page.getByRole('group', { name: 'Session history views' });
  await views.getByRole('button', { name: 'Orders', exact: true }).click();
  await page.getByLabel('Record side', { exact: true }).selectOption('SELL');
  await page.getByLabel('Record status', { exact: true }).selectOption('CANCELED');
  await page.getByLabel('Find record by ID', { exact: true }).fill(order.id);
  await expect(page.getByRole('row').filter({ hasText: 'Canceled' })).toHaveCount(1);
  const bookmark = page.url();
  const query = new URL(bookmark).searchParams;
  expect(Object.fromEntries(query)).toMatchObject({
    session: application.api.sessionId,
    kind: 'orders',
    search: order.id,
    side: 'SELL',
    status: 'CANCELED',
  });
  await page.reload();
  await expect(page.getByLabel('Trading session', { exact: true })).toHaveValue(
    application.api.sessionId,
  );
  await expect(views.getByRole('button', { name: 'Orders', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Find record by ID', { exact: true })).toHaveValue(order.id);
  await expect(page.getByLabel('Record side', { exact: true })).toHaveValue('SELL');
  await expect(page.getByLabel('Record status', { exact: true })).toHaveValue('CANCELED');
  await expect(page.getByRole('row').filter({ hasText: 'Canceled' })).toHaveCount(1);
  await page.getByLabel('Record side', { exact: true }).selectOption('BUY');
  await page.getByLabel('Record status', { exact: true }).selectOption('FILLED');
  await page.goBack();
  await expect(page.getByLabel('Record side', { exact: true })).toHaveValue('BUY');
  await expect(page.getByLabel('Record status', { exact: true })).toHaveValue('CANCELED');
  await page.goBack();
  await expect(page).toHaveURL(bookmark);
  await expect(page.getByLabel('Record side', { exact: true })).toHaveValue('SELL');
  await expect(page.getByRole('row').filter({ hasText: 'Canceled' })).toHaveCount(1);
  await page.goForward();
  await expect(page.getByLabel('Record side', { exact: true })).toHaveValue('BUY');
  await expect(page.getByText('No matching records', { exact: true })).toBeVisible();
});

test('administrator account scope and history tab survive reload and tab Back/Forward', async ({
  page,
  application,
}) => {
  const first = await application.api.trader('first_reader');
  const second = await application.api.trader('second_reader');
  await login(page, application.origin, 'operator');
  const navigation = page.getByRole('navigation', { name: 'Administrator views', exact: true });
  await navigation.getByRole('button', { name: 'Sessions & history', exact: true }).click();
  await page.getByRole('button', { name: /@first_reader/ }).click();
  await page
    .getByRole('group', { name: 'Session history views' })
    .getByRole('button', { name: 'Command outcomes', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`account=${first.user.accountId}`));
  await page.reload();
  await expect(
    navigation.getByRole('button', { name: 'Sessions & history', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: /@first_reader/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page
      .getByRole('group', { name: 'Session history views' })
      .getByRole('button', { name: 'Command outcomes', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: /@second_reader/ }).click();
  await expect(page).toHaveURL(new RegExp(`account=${second.user.accountId}`));
  await page.goBack();
  await expect(page.getByRole('button', { name: /@first_reader/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await navigation.getByRole('button', { name: 'Overview', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Sessions & history', exact: true }),
  ).not.toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: 'Sessions & history', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /@first_reader/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(new URL(page.url()).searchParams.get('account')).toBe(first.user.accountId);
});

test('unrelated live commits leave archive summaries stable and explicit refresh reads later metadata', async ({
  page,
  application,
}) => {
  const { trader, current } = await archive(application);
  let summaries = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === `/api/history/${application.api.sessionId}`)
      summaries += 1;
  });
  await login(page, application.origin, 'history_reader');
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('link', { name: 'History', exact: true })
    .click();
  await page.getByLabel('Trading session', { exact: true }).selectOption(application.api.sessionId);
  await expect(page.getByText('Archived session · read-only', { exact: true })).toBeVisible();
  await page
    .getByRole('group', { name: 'Session history views' })
    .getByRole('button', { name: 'Command outcomes', exact: true })
    .click();
  await expect(page.getByRole('table', { name: 'Durable command outcomes' })).toBeVisible();
  const baseline = summaries;
  const late = await trader.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: application.api.sessionId,
    side: 'SELL',
    quantity: '0.1',
    price: '50000',
  });
  expect(late.json()).toMatchObject({ status: 'REJECTED', code: 'STALE_SESSION' });
  const state = async (action: 'resume' | 'pause') =>
    application.api.admin.request('POST', `/api/admin/market/${action}`, {
      commandId: randomUUID(),
      sessionId: current.sessionId,
      reason: 'Advance the active session without changing the archive',
    });
  expect((await state('resume')).json()).toMatchObject({ status: 'ACCEPTED' });
  await expect(page.locator('.connection-strip .market-status')).toHaveText('TRADING');
  expect(summaries).toBe(baseline);
  await trader.browser.request('POST', '/api/orders', {
    commandId: randomUUID(),
    sessionId: current.sessionId,
    side: 'SELL',
    quantity: '0.1',
    price: '50000',
  });
  expect((await state('pause')).json()).toMatchObject({ status: 'ACCEPTED' });
  await expect(page.locator('.connection-strip .market-status')).toHaveText('PAUSED');
  expect(summaries).toBe(baseline);
  await expect(page.getByRole('table', { name: 'Durable command outcomes' })).not.toContainText(
    'Stale Session',
  );
  const summary = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/history/${application.api.sessionId}`,
  );
  await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
  const refreshed = (await (await summary).json()) as HistoryView;
  expect(
    refreshed.account?.commands.some(
      (command) => command.commandId === late.json<CommandResult>().commandId,
    ),
  ).toBe(true);
  await expect(page.getByRole('table', { name: 'Durable command outcomes' })).toContainText(
    'Stale Session',
  );
  expect(summaries).toBe(baseline + 1);
});

test('invalid history URL state cannot select another trader or administrator data', async ({
  page,
  application,
}) => {
  await application.api.trader('scoped_reader');
  const other = await application.api.trader('private_reader');
  await login(page, application.origin, 'scoped_reader');
  const scopes: Array<string | null> = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (/^\/api\/history\/[^/]+\/page$/.test(url.pathname))
      scopes.push(url.searchParams.get('accountId'));
  });
  await page.goto(
    `${application.origin}/history?session=invalid&account=${other.user.accountId}&kind=audit&side=INVALID&status=DELETED&search=%00`,
  );
  await expect(page).toHaveURL(`${application.origin}/history`);
  await expect(
    page
      .getByRole('group', { name: 'Session history views' })
      .getByRole('button', { name: 'Executions', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No matching records', { exact: true })).toBeVisible();
  expect(scopes.length).toBeGreaterThan(0);
  expect(scopes.every((value) => value === null)).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
