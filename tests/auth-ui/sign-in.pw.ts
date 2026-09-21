import { expect, test, type Page, type TestInfo } from '@playwright/test';

// UI-controller proof only: the rendered Next app and real client SDK use simulated
// auth responses. No server-auth, database, account, or mail-delivery proof is claimed.
const token = 'synthetic-unused-reset-token';
const password = 'Synthetic-password-123!';
const invalidLink = 'This link is invalid or expired. Request another link.';
const resetSuccess = 'Password updated. Sign in with your new password.';
const failures = new WeakMap<Page, { pageErrors: string[]; unexpectedAuth: string[] }>();

test.beforeEach(async ({ context, page, baseURL }) => {
  const pageErrors: string[] = [];
  const unexpectedAuth: string[] = [];
  failures.set(page, { pageErrors, unexpectedAuth });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    // Block public-page prefetches (which could open the corpus DB), external
    // services, and every unapproved API. Only the sign-in document/assets go live.
    if (url.origin === baseURL && route.request().method() === 'GET' &&
        (url.pathname === '/sign-in' || url.pathname.startsWith('/_next/static/'))) {
      await route.continue();
    } else {
      await route.abort();
    }
  });
  await page.route('**/api/auth/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/applicant') {
      await route.fulfill({ status: 401, json: { error: 'Sign in required.' } });
    } else if (path === '/api/auth/get-session') {
      await route.fulfill({ json: null });
    } else {
      unexpectedAuth.push(path);
      await route.fulfill({ status: 503, json: { message: 'Unconfigured test response.' } });
    }
  });
  test.info().annotations.push({ type: 'evidence', description: 'UI-controller proof; simulated auth responses; disposable Chromium context.' });
});

test.afterEach(async ({ page }) => {
  const recorded = failures.get(page)!;
  expect(recorded.pageErrors, 'No uncaught browser errors').toEqual([]);
  expect(recorded.unexpectedAuth, 'Every auth request needs an explicit simulation').toEqual([]);
});

async function layoutAndScreenshot(page: Page, info: TestInfo, name: string) {
  await expect(page.getByText('Checking session...', { exact: true })).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const controls = page.locator('input, button, nav a');
  for (const control of await controls.all()) {
    if (!await control.isVisible()) continue;
    const bounds = await control.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(info.project.use.viewport!.width);
  }
  await page.screenshot({
    path: info.outputPath(`${name}.png`),
    fullPage: true,
  });
}

test('reset survives reload and failure; only success removes the token', async ({ page }, info) => {
  const bodies: unknown[] = [];
  let status = 400;
  await page.route('**/api/auth/reset-password', async (route) => {
    bodies.push(route.request().postDataJSON());
    expect((await route.request().allHeaders()).referer).toBeUndefined();
    await route.fulfill({
      status,
      json: status === 200 ? { status: true } : { code: 'INVALID_TOKEN', message: 'Synthetic failure' },
    });
  });
  const response = await page.goto(`/sign-in?mode=reset&token=${token}`);
  expect(response?.headers()['referrer-policy']).toBe('no-referrer');
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`token=${token}`));
  await page.reload();
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await layoutAndScreenshot(page, info, 'reset-reloaded');
  await page.getByRole('button', { name: 'Set new password', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('This reset link is invalid or expired.');
  await expect(page).toHaveURL(new RegExp(`token=${token}`));
  expect(bodies).toEqual([{ token, newPassword: password }]);
  status = 200;
  await page.getByRole('button', { name: 'Set new password', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(resetSuccess);
  await expect(page).toHaveURL(/\/sign-in\?mode=reset$/);
  expect(bodies).toEqual([{ token, newPassword: password }, { token, newPassword: password }]);
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Confirm password', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)]))
    .not.toEqual(expect.arrayContaining([expect.stringContaining(token)]));
  await layoutAndScreenshot(page, info, 'reset-success');
  await page.reload();
  await expect(page).toHaveURL(/\/sign-in\?mode=reset$/);
  await expect(page.getByText(resetSuccess, { exact: true })).toHaveCount(0);
});

test('reset uses current search params after same-document navigation', async ({ page }) => {
  let submitted: unknown;
  await page.route('**/api/auth/reset-password', async (route) => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { status: true } });
  });
  await page.goto('/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.evaluate(() => window.history.pushState(null, '', '/sign-in?mode=reset&token=synthetic-first'));
  await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
  await page.evaluate(() => window.history.pushState(null, '', '/sign-in?mode=reset&token=synthetic-current'));
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Set new password', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText(resetSuccess);
  expect(submitted).toEqual({ token: 'synthetic-current', newPassword: password });
  await expect(page).toHaveURL(/\/sign-in\?mode=reset$/);
});

test('expired verification and arbitrary flags do not assert verification', async ({ page }, info) => {
  await page.goto('/sign-in?verified=1&error=TOKEN_EXPIRED');
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(invalidLink);
  await expect(page.getByText(/Email verified/i)).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveCount(0);
  await layoutAndScreenshot(page, info, 'expired-verification');
  await page.goto('/sign-in?verified=1');
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  await expect(page.getByText(/Email verified/i)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Account', exact: true })).toHaveCount(0);
});

test('mode changes clear errors, success notices, and credentials', async ({ page }, info) => {
  await page.route('**/api/auth/request-password-reset', (route) =>
    route.fulfill({ json: { status: true } }));
  await page.goto('/sign-in?mode=sign-up');
  await page.getByLabel('Name', { exact: true }).fill('Synthetic applicant');
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(`${password}mismatch`);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText('Passwords do not match.');
  await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
  await page.getByLabel('Email', { exact: true }).fill('synthetic@example.test');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('If this address is eligible, check your email to continue.');
  await layoutAndScreenshot(page, info, 'forgot-success');
  await page.getByRole('link', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('status')).toHaveCount(0);
  await page.getByRole('link', { name: 'Create account', exact: true }).click();
  for (const label of ['Name', 'Email', 'Password', 'Confirm password']) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue('');
  }
  await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
});

test('late reset responses cannot replace a different mode or leave stale success', async ({ page }) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/auth/reset-password', async (route) => {
    await held;
    await route.fulfill({ json: { status: true } });
  });
  await page.goto(`/sign-in?mode=reset&token=${token}`);
  await page.getByLabel('New password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  const request = page.waitForRequest('**/api/auth/reset-password');
  await page.getByRole('button', { name: 'Set new password', exact: true }).click();
  await request;
  await page.getByRole('link', { name: 'Forgot password?', exact: true }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
  const finished = page.waitForResponse('**/api/auth/reset-password');
  release();
  await (await finished).finished();
  await page.waitForLoadState('networkidle');
  await expect(page).toHaveURL(/\/sign-in\?mode=forgot$/);
  await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toHaveCount(0);
});

for (const outcome of ['success', 'error']) {
  for (const nextState of ['draft', 'pending']) {
    test(`delayed reset ${outcome} cannot change a newer token's ${nextState}`, async ({ page }) => {
      const nextToken = 'synthetic-next-reset-token';
      const nextPassword = 'Synthetic-next-password-456!';
      let releaseOld!: () => void;
      let releaseNext!: () => void;
      const oldResponse = new Promise<void>((resolve) => { releaseOld = resolve; });
      const nextResponse = new Promise<void>((resolve) => { releaseNext = resolve; });
      await page.route('**/api/auth/reset-password', async (route) => {
        const isOld = route.request().postDataJSON().token === token;
        await (isOld ? oldResponse : nextResponse);
        await route.fulfill({
          status: isOld && outcome === 'error' ? 400 : 200,
          json: isOld && outcome === 'error'
            ? { code: 'INVALID_TOKEN', message: 'Synthetic failure' } : { status: true },
        });
      });
      await page.goto(`/sign-in?mode=reset&token=${token}`);
      await page.getByLabel('New password', { exact: true }).fill(password);
      await page.getByLabel('Confirm password', { exact: true }).fill(password);
      const sentOld = page.waitForRequest('**/api/auth/reset-password');
      await page.getByRole('button', { name: 'Set new password', exact: true }).click();
      await sentOld;
      await page.evaluate((value) => window.history.pushState(null, '', `/sign-in?mode=reset&token=${value}`), nextToken);
      try {
        await expect(page.getByLabel('New password', { exact: true })).toBeEnabled();
        await page.getByLabel('New password', { exact: true }).fill(nextPassword);
        await page.getByLabel('Confirm password', { exact: true }).fill(nextPassword);
        if (nextState === 'pending') {
          const sentNext = page.waitForRequest('**/api/auth/reset-password');
          await page.getByRole('button', { name: 'Set new password', exact: true }).click();
          expect((await sentNext).postDataJSON()).toEqual({ token: nextToken, newPassword: nextPassword });
        }
        const finishedOld = page.waitForResponse((response) =>
          response.url().endsWith('/api/auth/reset-password') && response.request().postDataJSON().token === token);
        releaseOld();
        await (await finishedOld).finished();
        // Let the real client SDK settle; networkidle cannot be used while B is held.
        await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        await expect(page.getByLabel('New password', { exact: true })).toHaveValue(nextPassword);
        await expect(page.getByLabel('Confirm password', { exact: true })).toHaveValue(nextPassword);
        await expect(page).toHaveURL(new RegExp(`token=${nextToken}$`));
        await expect(page.getByRole('main').getByRole('alert')).toHaveCount(0);
        await expect(page.getByRole('status')).toHaveCount(0);
        if (nextState === 'pending') {
          await expect(page.getByRole('button', { name: 'Working...', exact: true })).toBeDisabled();
        } else {
          await expect(page.getByRole('button', { name: 'Set new password', exact: true })).toBeEnabled();
          const sentNext = page.waitForRequest('**/api/auth/reset-password');
          await page.getByRole('button', { name: 'Set new password', exact: true }).click();
          expect((await sentNext).postDataJSON()).toEqual({ token: nextToken, newPassword: nextPassword });
        }
        releaseNext();
        await expect(page.getByRole('status')).toHaveText(resetSuccess);
        await expect(page).toHaveURL(/\/sign-in\?mode=reset$/);
        await expect(page.getByLabel('New password', { exact: true })).toHaveValue('');
        await expect(page.getByLabel('Confirm password', { exact: true })).toHaveValue('');
        await expect(page.getByRole('button', { name: 'Set new password', exact: true })).toBeEnabled();
        expect(await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)].join('')))
          .not.toMatch(/synthetic-.*reset-token/);
      } finally {
        releaseOld();
        releaseNext();
      }
    });
  }
}

for (const mode of ['sign-in', 'sign-up', 'forgot', 'verify', 'reset']) {
  test(`${mode} has keyboard-accessible labels and fits the viewport`, async ({ page }, info) => {
    await page.goto(`/sign-in?mode=${mode}${mode === 'reset' ? `&token=${token}` : ''}`);
    const labels = mode === 'sign-up' ? ['Name', 'Email', 'Password', 'Confirm password']
      : mode === 'reset' ? ['New password', 'Confirm password']
        : mode === 'sign-in' ? ['Email', 'Password'] : ['Email'];
    await expect(page.getByLabel(labels[0], { exact: true })).toBeVisible();
    await page.getByRole('link', { name: 'Jobs', exact: true }).focus();
    for (const label of labels) {
      await page.keyboard.press('Tab');
      const input = page.getByLabel(label, { exact: true });
      await expect(input).toBeFocused();
      await expect(input).toHaveAccessibleName(label);
      await expect(input).toHaveCSS('outline-style', 'solid');
      await expect(input).toHaveCSS('outline-width', '2px');
    }
    await layoutAndScreenshot(page, info, `${mode}-keyboard`);
    await page.keyboard.press('Tab');
    await expect(page.locator('button[type="submit"]')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Sign in', exact: true })).toBeFocused();
  });
}
