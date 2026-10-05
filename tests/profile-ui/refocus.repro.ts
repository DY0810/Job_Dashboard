// Repro: returning to the tab must not reset scroll or drop an in-flight profile save.
// Usage: node tests/profile-ui/refocus.repro.ts http://127.0.0.1:3970
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createEmptyProfile, ProfileSchema } from '../../lib/applications/profile.ts';

const base = process.argv[2] ?? 'http://127.0.0.1:3970';
const owner = 'synthetic-owner';
const key = Buffer.alloc(32, 7).toString('base64');
let revision = 0;
let profile = ProfileSchema.parse(createEmptyProfile());
let patches = 0;
let saveDelay = 0;
const latency = Number(process.env.LATENCY ?? 0);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.route('**/*', async (route) => {
  const request = route.request();
  const url = new URL(request.url());
  if (!url.pathname.startsWith('/api/')) return route.continue();
  await new Promise((r) => setTimeout(r, latency));
  const json = (body: unknown) => route.fulfill({ json: body, headers: { 'Cache-Control': 'no-store' } });
  if (url.pathname === '/api/auth/applicant') return json({ ownerId: owner, name: 'S', email: 's@example.test' });
  if (url.pathname === '/api/auth/applicants') return json({ applicants: [{ ownerId: owner, name: 'S', email: 's@example.test', active: true }] });
  if (url.pathname === '/api/inbox') return json({ ownerId: owner, unread: 0, unresolved: 0, waitingApplications: 0, serverTime: Date.now(), items: [], nextCursor: null });
  if (url.pathname === '/api/profile/draft-key') return json({ ownerId: owner, keyVersion: '1', key });
  if (url.pathname === '/api/profile') {
    if (request.method() === 'GET') return json({ ownerId: owner, revision, profile });
    patches++;
    await new Promise((r) => setTimeout(r, saveDelay));
    const body = request.postDataJSON();
    if (body.expectedRevision === revision) { revision++; profile = body.profile; }
    return json({ ownerId: owner, revision, profile });
  }
  return json({});
});

async function refocus() {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
  });
}

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`PASS ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}: ${(e as Error).message}`); }
}

await page.goto(`${base}/profile`);
await page.getByRole('status').filter({ hasText: /Saved \/ revision/ }).waitFor();

// 1. Scroll position survives a tab switch.
await page.evaluate(() => window.scrollTo(0, 1500));
const before = await page.evaluate(() => window.scrollY);
await refocus();
await page.waitForTimeout(800);
const after = await page.evaluate(() => window.scrollY);
check('scroll kept after refocus', () => assert.ok(before > 500 && Math.abs(after - before) < 5, `scrollY ${before} -> ${after}`));

// 2. An edit saves even when the user switches tabs while the save is in flight.
saveDelay = 400;
const field = page.locator('section#identity input:not([type]), section#identity input[type="text"]').first();
await field.scrollIntoViewIfNeeded();
await field.fill(`edit-${Date.now()}`);
await page.waitForTimeout(700); // debounce fires, PATCH in flight
await refocus();
const until = async (ok: () => boolean) => { for (let t = 0; t < 40 && !ok(); t++) await page.waitForTimeout(500); };
const edited = await field.inputValue();
// Copying values from another window: the user keeps switching back every 1.5s.
for (let i = 0; i < 8 && !JSON.stringify(profile).includes(edited); i++) { await page.waitForTimeout(1500); await refocus(); }
check('save lands while switching windows', () => assert.ok(JSON.stringify(profile).includes(edited), `patches=${patches} revision=${revision}`));

// 3. Typing right after switching back to the tab is kept and saved.
const typed = `typed-${Date.now()}`;
await refocus();
await field.click().catch(() => {});
await page.keyboard.type(typed, { delay: 20 });
await until(() => JSON.stringify(profile).includes(typed));
const await0 = await field.inputValue().catch(() => '?');
const savedValue = JSON.stringify(profile);
check('typing right after refocus is saved', () => assert.ok(savedValue.includes(typed), `server lacks typed text; field="${await0}"`));

await browser.close();
process.exit(failed ? 1 : 0);
