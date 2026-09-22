import { expect, test, type Page } from '@playwright/test';
import { WorkerFixture } from '../worker-ui/fixture';
import { DiscoveryFixture, ownerA, ownerB } from './fixture';

// Parent-owned fresh loopback build only. No nested agents or cross-task messaging.
const fixtures = new WeakMap<Page, DiscoveryFixture>();
const workers = new WeakMap<Page, WorkerFixture>();
const statusReads = new WeakMap<Page, string[]>();
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ context, page, baseURL }) => {
  const fixture = new DiscoveryFixture(), worker = new WorkerFixture();
  worker.addRun(); worker.addRun();
  fixtures.set(page, fixture); workers.set(page, worker); statusReads.set(page, []); errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page)!.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('workie-applied:1', '1');
    localStorage.setItem('workie-applied:999999', '1');
    localStorage.setItem('workie-applied:02', '1');
    localStorage.setItem('workie-applied:3', 'true');
  });
  await context.route('**/*', async (route) => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === baseURL && request.method() === 'GET' &&
        (['/applications/import', '/workers'].includes(url.pathname) || url.pathname.startsWith('/_next/static/'))) return route.continue();
    if (url.origin !== baseURL || !url.pathname.startsWith('/api/')) return route.abort();
    const discovery = url.pathname.includes('/import/') || url.pathname.endsWith('/discovery') ||
      url.pathname === '/api/auth/applicant' || url.pathname === '/api/auth/applicants';
    if (url.pathname.endsWith('/discovery')) statusReads.get(page)!.push(url.pathname);
    try {
      const reply = await (discovery ? fixture : worker).handle(url.pathname, request.method(),
        new Headers(request.headers()), request.postData() ? request.postDataJSON() : null);
      await route.fulfill({ ...reply, headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (!(error instanceof TypeError && error.message === 'unsafe-secret-error')) errors.get(page)!.push(String(error));
      await route.abort('failed');
    }
  });
  test.info().annotations.push({ type: 'evidence', description: 'Synthetic API fixture, real UI; not backend or live-employer proof.' });
});
test.afterEach(async ({ page }) => {
  expect(errors.get(page)).toEqual([]);
  await expect(page.locator('body')).not.toContainText('unsafe-secret-error');
  expect(await page.locator('a').evaluateAll((links) => links.every((link) =>
    !/^(javascript|data|file):/i.test(link.getAttribute('href') ?? '')))).toBe(true);
});

async function preview(page: Page) {
  await page.goto('/applications/import');
  await expect(page.getByRole('button', { name: 'Preview browser marks', exact: true })).toBeEnabled();
  expect(fixtures.get(page)!.writes).toEqual([]);
  await page.getByRole('button', { name: 'Preview browser marks', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).toBeVisible();
}
async function select(page: Page) {
  await preview(page);
  await page.getByRole('checkbox', { name: 'Select posting 1', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Select posting 999999', exact: true }).check();
  await page.getByRole('checkbox', { name: /I own the selected/ }).check();
}

test('explicit preview, ownership and row selection import only canonical flags as manual records', async ({ page }) => {
  await preview(page);
  await expect(page.getByRole('button', { name: 'Import selected marks' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).not.toBeChecked();
  await expect(page.getByText('Unresolved manual record', { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select posting 999999', exact: true }).check();
  await page.getByRole('checkbox', { name: /I own the selected/ }).check();
  await page.getByRole('button', { name: 'Import selected marks' }).click();
  await expect(page.getByRole('status')).toContainText('No employer receipts created');
  expect(fixtures.get(page)!.writes[0].body.postingIds).toEqual([1, 999999]);
  expect(fixtures.get(page)!.writes[1].body.postingIds).toEqual([999999]);
  expect(await page.evaluate(() => localStorage.getItem('workie-applied:999999'))).toBe('1');
});

test('uncertain confirm and same-owner reauth retain exact request and selection', async ({ page }) => {
  await select(page);
  const fixture = fixtures.get(page)!;
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Import selected marks' }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.owner = null;
  await page.getByRole('button', { name: 'Check session' }).click();
  await expect(page.getByText('Import locked.', { exact: true })).toBeVisible();
  fixture.owner = ownerA;
  await page.getByRole('button', { name: 'Check session' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(page.getByRole('status')).toContainText('No employer receipts created');
  expect(fixture.writes[1]).toEqual(fixture.writes[2]);
});

test('backend expiry retains selection and renews only on explicit preview', async ({ page }) => {
  await select(page);
  const fixture = fixtures.get(page)!;
  fixture.rejectConfirm = 409;
  await page.getByRole('button', { name: 'Import selected marks' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Preview expired');
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).toBeChecked();
  expect(fixture.writes).toHaveLength(2);
  await page.getByRole('button', { name: 'Preview browser marks', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /I own the selected/ })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: /I own the selected/ })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).toBeChecked();
  expect(fixture.writes).toHaveLength(3);
  expect(fixture.writes[2].body.requestId).not.toEqual(fixture.writes[0].body.requestId);
});

test('principal switch clears preview and pending intent without attributing shared flags', async ({ page }) => {
  await select(page);
  const fixture = fixtures.get(page)!;
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Import selected marks' }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.owner = ownerB;
  await page.getByRole('button', { name: 'Check session' }).click();
  await expect(page.getByRole('checkbox', { name: 'Select posting 1', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  expect(fixture.writes).toHaveLength(2);
  expect(await page.evaluate(() => localStorage.getItem('workie-applied:1'))).toBe('1');
});

test('over 1000 flags visibly blocks import without silently previewing a subset', async ({ page }) => {
  await page.goto('/applications/import');
  await page.evaluate(() => {
    for (let i = 1; i <= 1001; i++) localStorage.setItem(`workie-applied:${i}`, '1');
  });
  await page.getByRole('button', { name: 'Preview browser marks' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('More than 1,000');
  expect(fixtures.get(page)!.writes).toEqual([]);
});

test('selected-run refresh shows complete backlog, current staging and truthful failed scan and fetch', async ({ page }) => {
  await page.goto('/workers');
  const runs = workers.get(page)!.runs;
  await expect(page.getByRole('link', { name: 'Import browser marks' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Discovery run', exact: true }).selectOption(runs[0].id);
  expect(statusReads.get(page)).toEqual([]);
  await page.getByRole('button', { name: 'Refresh discovery' }).click();
  await expect(page.getByText('691 retained targets', { exact: true })).toBeVisible();
  await expect(page.getByText('200 / 601 staged', { exact: true })).toBeVisible();
  await expect(page.getByText('Scan failed', { exact: true })).toBeVisible();
  const lastScan = await page.getByTestId('last-successful-scan').textContent();
  fixtures.get(page)!.failStatus = true;
  await page.getByRole('button', { name: 'Refresh discovery' }).click();
  await expect(page.getByText('Refresh failed. Showing the last fetched status.', { exact: true })).toBeVisible();
  expect(await page.getByTestId('last-successful-scan').textContent()).toBe(lastScan);
  await page.getByRole('combobox', { name: 'Discovery run', exact: true }).selectOption(runs[1].id);
  await expect(page.getByText('691 retained targets', { exact: true })).toHaveCount(0);
  expect(statusReads.get(page)).toEqual(Array(2).fill(`/api/application-runs/${runs[0].id}/discovery`));
});

test('import keyboard controls and dense layout fit the configured viewport', async ({ page }, testInfo) => {
  await preview(page);
  const checkbox = page.getByRole('checkbox', { name: 'Select posting 1', exact: true });
  await checkbox.focus();
  await page.keyboard.press('Space');
  await expect(checkbox).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('import.png'), fullPage: true });
});

test('discovery layout fits the configured viewport', async ({ page }, testInfo) => {
  await page.goto('/workers');
  await page.getByRole('combobox', { name: 'Discovery run', exact: true }).selectOption(workers.get(page)!.runs[0].id);
  await page.getByRole('button', { name: 'Refresh discovery' }).click();
  await expect(page.getByText('691 retained targets', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('discovery.png'), fullPage: true });
});
