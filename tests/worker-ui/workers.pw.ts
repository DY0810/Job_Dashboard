import { expect, test, type Page } from '@playwright/test';
import { PAIRING_TTL_MS } from '../../lib/applications/worker-protocol';
import { WorkerFixture, ownerB, syntheticGrant, workerId } from './fixture';

// Real Next UI, strict synthetic APIs. No keychain, real clipboard, browser profile,
// live account, service or employer. No nested agents or cross-task messaging.
const fixtures = new WeakMap<Page, WorkerFixture>();
const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ context, page, baseURL }) => {
  const fixture = new WorkerFixture();
  const failures: string[] = [];
  fixtures.set(page, fixture); errors.set(page, failures);
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.text().includes(syntheticGrant)) failures.push('Pairing secret leaked to console'); });
  await page.addInitScript(() => {
    const state = window as unknown as { copiedGrants: number };
    state.copiedGrants = 0;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { state.copiedGrants++; } } });
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.href.includes(syntheticGrant)) failures.push('Pairing secret leaked to URL');
    if (url.origin === baseURL && request.method() === 'GET' &&
        (url.pathname === '/workers' || url.pathname.startsWith('/_next/static/'))) return route.continue();
    if (url.origin !== baseURL || !url.pathname.startsWith('/api/')) return route.abort();
    try {
      const response = await fixture.handle(url.pathname, request.method(), new Headers(request.headers()),
        request.postData() ? request.postDataJSON() : null);
      await route.fulfill({ ...response, headers: { 'Cache-Control': 'private, no-store' } });
    } catch (error) {
      if (!(error instanceof TypeError && error.message === 'Synthetic lost acknowledgement')) {
        failures.push(error instanceof Error ? error.message : 'Fixture failure');
      }
      await route.abort('failed');
    }
  });
  test.info().annotations.push({ type: 'evidence', description: 'Real Next UI with strict synthetic worker APIs; no backend or live execution proof.' });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

async function ready(page: Page) {
  await page.goto('/workers');
  await expect(page.getByLabel('Worker label', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
}
async function refresh(page: Page) {
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
}
const grants = (page: Page) => page.getByRole('textbox', { name: 'Pairing grant', exact: true });
const run = (page: Page) => page.getByRole('list', { name: 'Runs', exact: true }).getByRole('listitem');

test('pairing approval is explicit, secret stays transient, copy is direct and expiry removes it', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  expect(fixture.writes).toHaveLength(0);
  await page.getByLabel('Worker label', { exact: true }).fill('Synthetic pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  const copies = () => page.evaluate(() => (window as unknown as { copiedGrants: number }).copiedGrants);
  expect(await copies()).toBe(0);
  expect(await page.evaluate((secret) => !location.href.includes(secret) &&
    !JSON.stringify(localStorage).includes(secret) && !JSON.stringify(sessionStorage).includes(secret), syntheticGrant)).toBe(true);
  expect(fixture.writes.every((request) => !JSON.stringify(request).includes(syntheticGrant))).toBe(true);
  await page.getByRole('button', { name: 'Copy grant', exact: true }).click();
  await expect.poll(copies).toBe(1);
  fixture.now += PAIRING_TTL_MS;
  await refresh(page);
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await page.reload();
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create pairing grant', exact: true })).toBeVisible();
});

test('lost pairing create replays the same request after same-owner auth refresh and reports hash-only conflict', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  fixture.loseNext = true;
  await page.getByLabel('Worker label', { exact: true }).fill('Unacknowledged pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.authStatus = 401;
  await refresh(page);
  await expect(page.getByText('Workers locked.', { exact: true })).toBeVisible();
  fixture.authStatus = 200;
  await refresh(page);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('Unacknowledged pairing');
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('secret is unavailable');
  await expect(grants(page)).toHaveCount(0);
  expect(fixture.pairings).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
  await page.getByRole('button', { name: 'Cancel pairing Unacknowledged pairing', exact: true }).click();
  await expect(page.getByText('Cancelled', { exact: true })).toBeVisible();
});

test('principal switch clears the grant, selected worker, label and in-flight response', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Owner A only');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  let release!: () => void;
  fixture.afterWrite = () => new Promise<void>((resolve) => { release = resolve; });
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  fixture.switchOwner();
  await refresh(page);
  release();
  await expect(page.getByText(`${ownerB}@example.test`, { exact: true })).toBeVisible();
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Run worker', exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  await expect(page.getByText('No runs.', { exact: true })).toBeVisible();
});

test('same-owner reauthentication retains selection grant and pending intent until explicit retry', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Owner A only');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.authStatus = 401;
  await refresh(page);
  await expect(grants(page)).toBeHidden();
  fixture.authStatus = 200;
  await refresh(page);
  await expect(page.getByRole('combobox', { name: 'Run worker', exact: true })).toHaveValue(workerId);
  await expect(page.getByLabel('Worker label', { exact: true })).toHaveValue('Owner A only');
  await expect(grants(page)).toBeVisible();
  expect(fixture.writes).toHaveLength(2);
  await page.getByRole('link', { name: 'Profile', exact: true }).click();
  await expect(page).toHaveURL(/\/workers$/);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('request is unresolved');
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  expect(fixture.writes[1].body).toEqual(fixture.writes[2].body);
  expect(fixture.runs).toHaveLength(1);
  await page.getByRole('button', { name: 'Dismiss secret', exact: true }).click();
  await refresh(page);
  await expect(grants(page)).toHaveCount(0);
});

test('worker revoke and pairing cancellation reconcile CAS and current heads', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  await ready(page);
  fixture.workers[0].revision++;
  await page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('State changed');
  await expect(page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Revoke Synthetic laptop', exact: true }).click();
  await expect(page.getByText('Revoked', { exact: true })).toBeVisible();
  await expect(run(page).getByText('paused', { exact: true })).toBeVisible();
  await expect(run(page).getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  expect(fixture.writes[0].body!.requestId).not.toBe(fixture.writes[1].body!.requestId);
});

test('run create replay shows the newer stopped head and controls persist across reload', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  fixture.loseNext = true;
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  fixture.runs[0].state = 'stopped'; fixture.runs[0].revision++;
  await refresh(page);
  await page.getByRole('button', { name: 'Retry pending request' }).click();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Earlier request acknowledged. Current state loaded.', { exact: true })).toBeVisible();
  await expect(run(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await expect(page.getByText('Policy intent enabled / Execution available', { exact: true })).toBeVisible();
});

for (const target of ['same', 'different'] as const) {
  test(`delayed-before-commit resume survives only an unrelated emergency stop: ${target} run`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    const a = fixture.addRun('paused'), b = target === 'same' ? a : fixture.addRun();
    fixture.addApplication('submitting', 'submit_started', b.id);
    await ready(page);
    const aRow = page.getByRole('listitem', { name: `Run ${a.id.slice(0, 8)}`, exact: true });
    const bRow = page.getByRole('listitem', { name: `Run ${b.id.slice(0, 8)}`, exact: true });
    let release!: () => void;
    fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
    await aRow.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(() => typeof release).toBe('function');
    const body = structuredClone(fixture.writes[0].body);
    expect(a.state).toBe('paused');
    fixture.beforeWrite = undefined;
    await bRow.getByRole('button', { name: 'Emergency stop', exact: true }).click();
    await expect(bRow.getByText('stopped', { exact: true })).toBeVisible();
    release();
    const retry = page.getByRole('button', { name: 'Retry pending request', exact: true });
    if (target === 'same') {
      await expect(retry).toHaveCount(0);
      await refresh(page);
      await expect(aRow.getByText('stopped', { exact: true })).toBeVisible();
      expect(fixture.writes).toHaveLength(2);
    } else {
      await expect(retry).toBeEnabled();
      await expect(aRow.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
      await page.getByRole('link', { name: 'Profile', exact: true }).click();
      await expect(page).toHaveURL(/\/workers$/);
      await refresh(page);
      await expect(aRow.getByText('running', { exact: true })).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
      expect(fixture.writes).toHaveLength(3);
      expect(fixture.writes[2].body).toEqual(body);
    }
    await expect(page.getByText('submission unknown', { exact: true })).toBeVisible();
  });
}

test('a submitting sibling can be emergency stopped without losing a delayed application command', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const a = fixture.addApplication('queued');
  fixture.addApplication('submitting', 'submit_started');
  await ready(page);
  const aRow = page.getByRole('listitem', { name: 'Application role-1', exact: true });
  const bRow = page.getByRole('listitem', { name: 'Application role-2', exact: true });
  let release!: () => void;
  fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
  await aRow.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect.poll(() => typeof release).toBe('function');
  const body = structuredClone(fixture.writes[0].body);
  fixture.beforeWrite = undefined;
  await bRow.getByRole('button', { name: 'Emergency stop', exact: true }).click();
  await expect(bRow.getByText('submission unknown', { exact: true })).toBeVisible();
  release();
  await expect.poll(() => a.state).toBe('skipped');
  const retry = page.getByRole('button', { name: 'Retry pending request', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(aRow.getByText('skipped', { exact: true })).toBeVisible();
  expect(fixture.writes).toHaveLength(3);
  expect(fixture.writes[2].body).toEqual(body);
  await expect(bRow.getByRole('button')).toHaveCount(1);
});

test('a delayed head cannot republish an expired grant or an artificially online worker', async ({ page }) => {
  await page.addInitScript(() => {
    const clock = window as unknown as { workerMonotonic: number };
    clock.workerMonotonic = 0;
    Object.defineProperty(performance, 'now', { value: () => clock.workerMonotonic });
  });
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Worker label', { exact: true }).fill('Expiring pairing');
  await page.getByRole('button', { name: 'Create pairing grant', exact: true }).click();
  await expect(grants(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  const handle = fixture.handle.bind(fixture);
  let release!: () => void;
  fixture.handle = async (...args) => {
    const response = await handle(...args);
    if (args[0] === '/api/application-runs') await new Promise<void>((resolve) => { release = resolve; });
    return response;
  };
  await page.getByRole('button', { name: 'Refresh status' }).click();
  await expect.poll(() => typeof release).toBe('function');
  await page.evaluate((elapsed) => { (window as unknown as { workerMonotonic: number }).workerMonotonic = elapsed; }, PAIRING_TTL_MS + 1);
  fixture.now += PAIRING_TTL_MS + 1;
  fixture.handle = handle;
  release();
  await expect(page.getByRole('button', { name: 'Refresh status' })).toBeEnabled();
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copiedGrants: number }).copiedGrants)).toBe(0);
});

test('pause resume stop and emergency stop are durable; unknown applications never offer retry skip or cancel', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.addApplication('submission_unknown', 'receipt_not_verified');
  fixture.addApplication('provider_unavailable', 'provider_not_configured');
  fixture.addApplication('needs_document', 'missing_resume');
  await ready(page);
  const unknown = page.getByRole('listitem', { name: 'Application role-1', exact: true });
  await expect(unknown.getByText('Reason: receipt_not_verified', { exact: true })).toBeVisible();
  await expect(unknown.getByRole('button')).toHaveCount(1);
  await expect(unknown.getByRole('button', { name: 'Emergency stop' })).toBeVisible();
  const retryable = page.getByRole('listitem', { name: 'Application role-2', exact: true });
  await retryable.getByRole('button', { name: 'Retry safe', exact: true }).click();
  await expect(retryable.getByText('screening', { exact: true })).toBeVisible();
  const blocked = page.getByRole('listitem', { name: 'Application role-3', exact: true });
  await expect(blocked.getByRole('button', { name: 'Retry safe', exact: true })).toHaveCount(0);
  await expect(blocked.getByText('Reason: missing_resume', { exact: true })).toBeVisible();
  await run(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(run(page).getByText('paused', { exact: true })).toBeVisible();
  await page.reload();
  await run(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(run(page).getByText('running', { exact: true })).toBeVisible();
  await run(page).getByRole('button', { name: 'Emergency stop', exact: true }).click();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await expect(unknown.getByText('submission unknown', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  const next = run(page).filter({ has: page.getByRole('button', { name: 'Stop', exact: true }) });
  await expect(next).toHaveCount(1);
  await next.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(next).toHaveCount(0);
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toHaveCount(2);
});

test('skip cancel and a server-rejected safe retry reconcile without inventing a retry budget', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.addApplication('needs_answer', 'answer_required');
  fixture.addApplication('queued');
  const retryable = fixture.addApplication('retryable_failure', 'temporary_failure');
  await ready(page);
  const skipped = page.getByRole('listitem', { name: 'Application role-1', exact: true });
  const cancelled = page.getByRole('listitem', { name: 'Application role-2', exact: true });
  const retry = page.getByRole('listitem', { name: 'Application role-3', exact: true });
  await skipped.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(skipped.getByText('skipped', { exact: true })).toBeVisible();
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cancelled.getByText('cancelled', { exact: true })).toBeVisible();
  for (let attempt = 0; attempt < 3; attempt++) {
    await retry.getByRole('button', { name: 'Retry safe', exact: true }).click();
    await expect(retry.getByText('screening', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
    retryable.state = 'retryable_failure'; retryable.reasonCode = 'temporary_failure'; retryable.revision++;
    await refresh(page);
  }
  await retry.getByRole('button', { name: 'Retry safe', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('State changed');
  await expect(page.getByRole('button', { name: 'Retry pending request' })).toHaveCount(0);
  await expect(retry.getByText('retryable failure', { exact: true })).toBeVisible();
  await page.reload();
  await expect(skipped.getByText('skipped', { exact: true })).toBeVisible();
  await expect(cancelled.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(skipped.getByRole('button')).toHaveCount(0);
  await expect(cancelled.getByRole('button')).toHaveCount(0);
});

test('offline unpaired disabled-policy configuration and unknown-protocol states remain honest', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.workers[0].online = false;
  fixture.policy.enabled = false;
  await ready(page);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await expect(page.getByRole('button', { name: 'Create run', exact: true })).toBeDisabled();
  fixture.workers = [];
  await refresh(page);
  await expect(page.getByText('Unpaired / no workers.', { exact: true })).toBeVisible();
  fixture.addRun(); fixture.invalidState = true;
  await refresh(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Incompatible worker response');
  await expect(page.getByLabel('Worker label', { exact: true })).toBeHidden();
  fixture.invalidState = false; fixture.authStatus = 503;
  await refresh(page);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('configuration');
});

test('dense layout has native labels keyboard focus and no overflow in light and dark', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.workers[0].label = 'Synthetic workstation with a deliberately long but valid worker label';
  fixture.addApplication('needs_policy_decision', 'country_scope_requires_owner_confirmation');
  await ready(page);
  const input = page.getByLabel('Worker label', { exact: true });
  await input.fill('Keyboard pairing');
  await input.focus();
  await expect(input).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Create pairing grant', exact: true })).toBeFocused();
  await expect(page.getByRole('link', { name: 'Profile', exact: true })).toHaveAttribute('href', '/profile');
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const controls = await page.locator('main button:visible, main input:visible, main select:visible').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height,
        overflow: element.scrollWidth > element.clientWidth + 1 };
    }));
  for (const box of controls) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
    expect(box.height).toBeGreaterThanOrEqual(30);
    expect(box.width).toBeGreaterThan(0);
    expect(box.overflow).toBe(false);
  }
  await page.screenshot({ path: info.outputPath('workers.png'), fullPage: true });
});
