import { expect, test, type Page, type Route, type TestInfo } from '@playwright/test';

// UI-controller proof only: the rendered Next app talks to simulated household-auth
// responses. No server passcode check, cookie, rate limit or database proof is claimed.
const testPasscode = '2468'; // the test value lib/household-auth.test.ts uses; never a real one
const wrongPasscode = '0000';
const may = { ownerId: 'synthetic-may', email: 'may@example.test', name: 'May' };
const failures = new WeakMap<Page, { pageErrors: string[]; unexpectedAuth: string[] }>();

test.beforeEach(async ({ context, page, baseURL }) => {
  const pageErrors: string[] = [];
  const unexpectedAuth: string[] = [];
  failures.set(page, { pageErrors, unexpectedAuth });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const local = url.origin === baseURL && request.method() === 'GET';
    // Block public-page prefetches (which could open the corpus DB), external
    // services, and every unapproved API. Only the sign-in document/assets go live.
    if (local && (url.pathname === '/sign-in' || url.pathname.startsWith('/_next/static/'))) {
      await route.continue();
    } else if (local && url.pathname === '/' && request.resourceType() === 'document') {
      // Stands in for the jobs board an unlock lands on.
      await route.fulfill({ contentType: 'text/html', body: '<title>Jobs</title><h1>Jobs</h1>' });
    } else {
      await route.abort();
    }
  });
  await page.route('**/api/auth/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/household' && request.method() === 'GET') {
      await route.fulfill({ status: 401, json: { error: 'Passcode required.' } });
    } else {
      unexpectedAuth.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 503, json: { error: 'Unconfigured test response.' } });
    }
  });
  test.info().annotations.push({ type: 'evidence', description: 'UI-controller proof; simulated household auth; disposable Chromium context.' });
});

test.afterEach(async ({ page }) => {
  const recorded = failures.get(page)!;
  expect(recorded.pageErrors, 'No uncaught browser errors').toEqual([]);
  expect(recorded.unexpectedAuth, 'Every auth request needs an explicit simulation').toEqual([]);
});

/** Answers the unlock POST and records each body; GET falls through to the locked default. */
async function answerUnlock(page: Page, reply: (route: Route) => Promise<void>) {
  const bodies: unknown[] = [];
  await page.route('**/api/auth/household', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    bodies.push(route.request().postDataJSON());
    await reply(route);
  });
  return bodies;
}

async function openForm(page: Page) {
  const response = await page.goto('/sign-in');
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.getByRole('textbox', { name: 'Passcode', exact: true })).toBeVisible();
}

async function layoutAndScreenshot(page: Page, info: TestInfo, name: string) {
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No sideways scroll').toBe(true);
  const controls = page.locator('input, select, button, nav a');
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  }
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

test('wrong passcode shows the error and keeps the form', async ({ page }, info) => {
  const bodies = await answerUnlock(page, (route) =>
    route.fulfill({ status: 401, json: { error: 'Incorrect passcode.' } }));
  await openForm(page);
  const passcode = page.getByRole('textbox', { name: 'Passcode', exact: true });
  const unlock = page.getByRole('button', { name: 'Unlock Workie', exact: true });
  await expect(passcode).toHaveAttribute('type', 'password');
  await expect(passcode).toHaveAttribute('inputmode', 'numeric');
  await expect(passcode).toHaveAttribute('autocomplete', 'current-password');
  // An empty code is held back by the browser; the single body below proves nothing was sent.
  await unlock.click();
  expect(await passcode.evaluate((input: HTMLInputElement) => input.validity.valueMissing)).toBe(true);
  await page.getByRole('combobox', { name: 'Applicant', exact: true }).selectOption('may');
  await passcode.fill(wrongPasscode);
  await unlock.click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Incorrect passcode.');
  expect(bodies).toEqual([{ passcode: wrongPasscode, profile: 'may' }]);
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(unlock).toBeEnabled();
  await expect(passcode).toBeEditable();
  await layoutAndScreenshot(page, info, 'wrong-passcode');
});

test('test passcode unlocks and opens Jobs', async ({ page, baseURL }, info) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const bodies = await answerUnlock(page, async (route) => {
    await held;
    await route.fulfill({ json: may });
  });
  // The unlocked view mounts the applicant switcher for a moment before the redirect.
  await page.route('**/api/auth/applicants', (route) =>
    route.fulfill({ json: { applicants: [{ ...may, active: true }] } }));
  await openForm(page);
  await page.getByRole('combobox', { name: 'Applicant', exact: true }).selectOption('may');
  await page.getByRole('textbox', { name: 'Passcode', exact: true }).fill(testPasscode);
  const sent = page.waitForRequest((request) => request.method() === 'POST' && request.url().endsWith('/api/auth/household'));
  await page.getByRole('textbox', { name: 'Passcode', exact: true }).press('Enter');
  await sent;
  await expect(page.getByRole('button', { name: 'Unlocking…', exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Passcode', exact: true })).toBeDisabled();
  await layoutAndScreenshot(page, info, 'unlocking');
  release();
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
  expect(bodies).toEqual([{ passcode: testPasscode, profile: 'may' }]);
});

test('applicant and passcode are labelled and reachable by keyboard', async ({ page }, info) => {
  await openForm(page);
  // Start from the heading so the next Tab enters the form, past the sidebar.
  await page.getByRole('heading', { name: 'Household access', exact: true }).click();
  const order = [
    page.getByRole('combobox', { name: 'Applicant', exact: true }),
    page.getByRole('textbox', { name: 'Passcode', exact: true }),
    page.getByRole('button', { name: 'Unlock Workie', exact: true }),
  ];
  for (const control of order) {
    await page.keyboard.press('Tab');
    await expect(control).toBeFocused();
    await expect(control).toHaveCSS('outline-style', 'solid');
    await expect(control).toHaveCSS('outline-width', '2px');
  }
  await expect(order[0]).toHaveAccessibleName('Applicant');
  await expect(order[1]).toHaveAccessibleName('Passcode');
  await layoutAndScreenshot(page, info, 'keyboard');
});
