import { expect, test, type Page } from '@playwright/test';
import { SUBMIT_APPROVAL } from '../../lib/applications/state';
import { PAIRING_TTL_MS, PARKED_STEPS } from '../../lib/applications/worker-protocol';
import { WorkerFixture, syntheticGrant, workerId } from './fixture';

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
        (url.pathname === '/applications' || url.pathname.startsWith('/_next/static/'))) return route.continue();
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

// Workers lives in the settings drawer over Auto Apply; the drawer's Refresh reloads it (the header is inert under the modal).
const settings = (page: Page) => page.getByRole('dialog', { name: 'Settings', exact: true });
const alert = (page: Page) => settings(page).getByRole('region', { name: 'Workers', exact: true }).getByRole('alert');
const checking = (page: Page) => page.getByText('Checking applicant session...', { exact: true });
async function ready(page: Page) {
  await page.goto('/applications?settings=1');
  await expect(settings(page)).toBeVisible();
  await expect(page.getByLabel('Worker label', { exact: true })).toBeVisible();
}
/** A manual refresh locks Workers and shows the session check until it finishes, like the old Refresh status button. */
async function refresh(page: Page) {
  const before = fixtures.get(page)!.requests.length;
  await settings(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => fixtures.get(page)!.requests.length).toBeGreaterThan(before);
  await expect(checking(page)).toHaveCount(0);
}
/** Closing the drawer with a request unresolved is refused, as leaving the Workers page was. */
async function tryToLeave(page: Page) {
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeVisible();
  await expect(page).toHaveURL(/[?&]settings=1/);
  await expect(alert(page)).toContainText('request is unresolved');
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
  await expect(alert(page)).toContainText('secret is unavailable');
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
  await tryToLeave(page);
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
  await expect(alert(page)).toContainText('State changed');
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
  await expect(page.getByText('Policy enabled / Runner online', { exact: true })).toBeVisible();
});

for (const target of ['same', 'different'] as const) {
  test(`delayed-before-commit resume survives only an unrelated emergency stop: ${target} run`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    const a = fixture.addRun('paused'), b = target === 'same' ? a : fixture.addRun();
    const app = fixture.addApplication('submitting', 'submit_started', b.id);
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
      await tryToLeave(page);
      await refresh(page);
      await expect(aRow.getByText('running', { exact: true })).toBeVisible();
      await retry.click();
      await expect(retry).toHaveCount(0);
      expect(fixture.writes).toHaveLength(3);
      expect(fixture.writes[2].body).toEqual(body);
    }
    expect(app.state).toBe('submission_unknown');
  });
}

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
  // Workers, Settings and the Auto Apply page each read runs on refresh; hold all three.
  const releases: (() => void)[] = [];
  fixture.handle = async (...args) => {
    const response = await handle(...args);
    if (args[0] === '/api/application-runs') await new Promise<void>((resolve) => { releases.push(resolve); });
    return response;
  };
  await settings(page).getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => releases.length).toBe(3);
  await page.evaluate((elapsed) => { (window as unknown as { workerMonotonic: number }).workerMonotonic = elapsed; }, PAIRING_TTL_MS + 1);
  fixture.now += PAIRING_TTL_MS + 1;
  fixture.handle = handle;
  for (const release of releases) release();
  await expect(checking(page)).toHaveCount(0);
  await expect(grants(page)).toHaveCount(0);
  await expect(page.getByText('Expired', { exact: true })).toBeVisible();
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copiedGrants: number }).copiedGrants)).toBe(0);
});

test('pause resume stop and emergency stop are durable', async ({ page }) => {
  fixtures.get(page)!.addRun();
  await ready(page);
  await run(page).getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(run(page).getByText('paused', { exact: true })).toBeVisible();
  await page.reload();
  await run(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(run(page).getByText('running', { exact: true })).toBeVisible();
  await run(page).getByRole('button', { name: 'Emergency stop', exact: true }).click();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await page.getByRole('button', { name: 'Create run', exact: true }).click();
  const next = run(page).filter({ has: page.getByRole('button', { name: 'Stop', exact: true }) });
  await expect(next).toHaveCount(1);
  await next.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(next).toHaveCount(0);
  await page.reload();
  await expect(run(page).getByText('stopped', { exact: true })).toHaveCount(2);
});

test('offline unpaired disabled-policy configuration and unknown-protocol states remain honest', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.workers[0].online = false;
  fixture.policy.enabled = false;
  await ready(page);
  await expect(page.getByText('Offline', { exact: true })).toBeVisible();
  // Auto Apply itself says so too, not only Settings.
  await expect(page.getByText(/^Your worker is offline, last seen .+\. Nothing is applied until it is back online\.$/)).toBeVisible();
  await page.getByRole('combobox', { name: 'Run worker', exact: true }).selectOption(workerId);
  await expect(page.getByRole('button', { name: 'Create run', exact: true })).toBeDisabled();
  fixture.workers = [];
  await refresh(page);
  await expect(page.getByText('Unpaired / no workers.', { exact: true })).toBeVisible();
  fixture.addRun(); fixture.invalidState = true;
  await refresh(page);
  await expect(alert(page)).toContainText('Incompatible worker response');
  await expect(page.getByLabel('Worker label', { exact: true })).toBeHidden();
  fixture.invalidState = false; fixture.authStatus = 503;
  await refresh(page);
  await expect(alert(page)).toContainText('configuration');
});

// Embedded browsers (the Claude app's pane, in-app web views) return false from window.confirm without asking,
// so Apply and Archive did nothing there. They ask on the page instead.
test('Apply and Archive ask on the page, never through a browser prompt', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_policy_decision', SUBMIT_APPROVAL);
  page.on('dialog', (dialog) => { errors.get(page)!.push(`Browser prompt: ${dialog.message()}`); void dialog.dismiss(); });
  const writes = () => fixture.requests.filter((request) => request.method !== 'GET');
  await page.goto('/applications');
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Archive this application? It is still live, so this also cancels it.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(writes()).toEqual([]);

  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Approve / fixture-employer', exact: true });
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(review.getByText('Submit this application to the employer now? This cannot be undone.', { exact: true })).toBeVisible();
  expect(writes()).toEqual([]);
  await review.getByRole('button', { name: 'Yes, apply', exact: true }).click();
  await expect.poll(() => writes().map((request) => request.body?.action)).toEqual(['approve-submit']);
  expect(writes()[0].path).toBe(`/api/application-runs/${app.runId}/applications/${app.id}/actions`);
});

/** A 1x1 PNG: the browser shows it under the page's image/jpeg data URL like the worker's screenshot. */
const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

// Apply moves the row to 'ready' while the worker fills the form again and submits it; Live used to drop it, closing full screen.
test('Apply in Live full screen keeps the form on screen while the worker submits it', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('needs_policy_decision', SUBMIT_APPROVAL);
  // Fresh, as when the applicant presses Apply right after the fill: the frame the worker parked the form with is not the refill.
  fixture.frames = [{ applicationId: app.id, step: PARKED_STEPS.approval, image: PIXEL,
    fields: [{ label: 'First Name', value: 'Test' }], updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  await page.getByRole('button', { name: 'Full screen', exact: true }).click();
  const full = page.getByRole('dialog', { name: 'fixture-employer application, full screen', exact: true });
  await full.getByRole('button', { name: 'Apply', exact: true }).click();
  await full.getByRole('button', { name: 'Yes, apply', exact: true }).click();
  await expect(full.getByText(/^Approved\. Waiting for the worker to submit it/)).toBeVisible();
  await expect(full.getByRole('img', { name: 'Workie\'s browser filling the fixture-employer application', exact: true })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Live', exact: true }).getByRole('listitem')).toHaveCount(1);
  expect(fixture.writes.map((request) => request.body?.action)).toEqual(['approve-submit']);
});

// listLive stops sending a row's frame once it leaves Live; the card used to stay, saying the form had not gone out, until the minute's refresh.
test('Live drops a form the worker submitted at its next frame poll', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('submitting');
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form again and submitting it', image: PIXEL, fields: null, updatedAt: Date.now() }];
  await page.goto('/applications?view=live');
  await expect(page.getByRole('list', { name: 'Live', exact: true }).getByText(/^Filling the form again and submitting it · updated/)).toBeVisible();
  app.state = 'submitted';
  await expect(page.getByText(/^Nothing is being applied right now\./)).toBeVisible({ timeout: 10_000 });
});

// Rows reload once a minute and frames every 3 s; Live used to wait for the rows to show a form the worker had started filling.
test('Live shows a form the worker starts filling after the page loaded, at its next frame', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  const app = fixture.addApplication('queued');
  await page.goto('/applications?view=live');
  await expect(page.getByText(/^Nothing is being applied right now\./)).toBeVisible();
  app.state = 'filling';
  fixture.frames = [{ applicationId: app.id, step: 'Filling the form', image: PIXEL, fields: null, updatedAt: Date.now() }];
  const live = page.getByRole('list', { name: 'Live', exact: true });
  await expect(live.getByText(/^Filling the form · updated/)).toBeVisible({ timeout: 10_000 });
  await expect(live.getByRole('img', { name: 'Workie\'s browser filling the fixture-employer application', exact: true })).toBeVisible();
});

test('dense layout has native labels keyboard focus and no overflow in light and dark', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  fixture.addRun();
  fixture.workers[0].label = 'Synthetic workstation with a deliberately long but valid worker label';
  fixture.addApplication('needs_policy_decision', 'country_scope_requires_owner_confirmation');
  // Measure the drawer where it rests, not mid slide-in.
  await page.emulateMedia({ reducedMotion: 'reduce' });
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
  // The shared header has its own layout; this checks the page and the drawer.
  const controls = await page.locator('main button:visible, main input:visible, main select:visible').evaluateAll((elements) =>
    elements.filter((element) => !element.closest('.app-header')).map((element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, right: box.right, width: box.width, height: box.height,
        overflow: element.scrollWidth > element.clientWidth + 1 };
    }));
  for (const box of controls) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
    // Dense desktop controls are 28px (workers.module.css .button).
    expect(box.height).toBeGreaterThanOrEqual(28);
    expect(box.width).toBeGreaterThan(0);
    expect(box.overflow).toBe(false);
  }
  await page.screenshot({ path: info.outputPath('workers.png'), fullPage: true });
});
