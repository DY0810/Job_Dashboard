import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test';
import { createEmptyProfile, ProfileSchema, ProfileSaveSchema, profileEnablementIssues, PROFILE_SECTION_LABELS, type Profile } from '../../lib/applications/profile';
import { createEmptyPolicy, PolicySaveSchema, PolicyCommandSchema, type PolicyResponse } from '../../lib/applications/policy';

// UI proof only: real rendered Next components, explicit synthetic API responses.
// No real authentication, database, document safety, cloud upload, model, or ATS proof.
const ownerA = 'synthetic-owner-a';
const ownerB = 'synthetic-owner-b';
const key = Buffer.alloc(32, 7).toString('base64');
const id = () => crypto.randomUUID();
function confirmed<T extends { state: string; value: unknown; confirmedAt: string | null }>(fact: T, value: unknown): T {
  return { ...fact, state: 'confirmed', value, confirmedAt: '2026-09-20T12:00:00.000Z' } as T;
}
function fixtureProfile(): Profile {
  const profile = createEmptyProfile();
  profile.identity.legalFirstName = confirmed(profile.identity.legalFirstName, 'Synthetic');
  profile.identity.legalLastName = confirmed(profile.identity.legalLastName, 'Applicant');
  profile.identity.personalEmail = confirmed(profile.identity.personalEmail, 'synthetic@example.test');
  return ProfileSchema.parse(profile);
}
function savedPolicy(enabled = false): PolicyResponse {
  return {
    revision: enabled ? 2 : 1,
    policy: { ...createEmptyPolicy(), actions: ['read_jobs'], destinations: ['employer.example.test'], countries: ['US'] },
    policyVersion: 1, policyHash: 'a'.repeat(64), enabled,
    acceptedAt: enabled ? '2026-09-20T12:00:00.000Z' : null,
    acceptedPolicyHash: enabled ? 'a'.repeat(64) : null, acceptedPolicyVersion: enabled ? 1 : null, runnerAvailable: false,
  };
}
type Fixture = {
  owner: string; auth: number; revision: number; profile: Profile; writes: Record<string, unknown>[];
  mode: 'ok' | 'offline' | 'conflict'; policyWrites: { method: string; body: Record<string, unknown> }[];
  documents: Record<string, unknown>[]; storage: 'local' | 'unconfigured'; uploads: number;
  documentError: boolean; errors: string[];
  policy: PolicyResponse; policyMode: 'ok' | 'offline' | 'lost'; policyGets: number;
  beforePolicyWrite?: () => Promise<void>; afterPolicyWrite?: () => Promise<void>;
  documentListError: boolean; grantResponseLost: boolean; grantRequests: string[]; grantBodies: Record<string, unknown>[];
  uploadMode: 'ok' | 'lost' | 'unknown' | 'rejected'; failListAfterUpload: boolean;
};
const fixtures = new WeakMap<Page, Fixture>();

test.beforeEach(async ({ context, page, baseURL }) => {
  const fixture: Fixture = {
    owner: ownerA, auth: 200, revision: 0, profile: fixtureProfile(), writes: [], mode: 'ok',
    policyWrites: [], documents: [], storage: 'local', uploads: 0, documentError: false, errors: [],
    policy: { ...savedPolicy(), revision: 0, policy: createEmptyPolicy(), policyVersion: 0, policyHash: null },
    policyMode: 'ok', policyGets: 0, documentListError: false, grantResponseLost: false, grantRequests: [], grantBodies: [],
    uploadMode: 'ok', failListAfterUpload: false,
  };
  fixtures.set(page, fixture);
  page.on('pageerror', (error) => fixture.errors.push(error.message));
  const acknowledgements = new Map<string, { body: unknown; ack: unknown }>();
  const policyAcks = new Map<string, { body: unknown; ack: PolicyResponse }>();
  const grants = new Map<string, { body: unknown; response: { document: Record<string, unknown>; grantId: string; pathname: string; uploadMode: string; uploadUrl: string } }>();
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === baseURL && request.method() === 'GET' &&
        (url.pathname === '/profile' || url.pathname.startsWith('/_next/static/'))) return route.continue();
    if (url.origin !== baseURL || !url.pathname.startsWith('/api/')) return route.abort();
    const headers = { 'Cache-Control': 'private, no-store' };
    if (url.pathname === '/api/auth/applicant') return route.fulfill({
      status: fixture.auth, headers, json: fixture.auth === 200 ? { ownerId: fixture.owner, name: 'Synthetic', email: 'synthetic@example.test' } : { error: 'Sign in required.' },
    });
    if (url.pathname === '/api/auth/applicants') return route.fulfill({ headers, json: { applicants: [
      { ownerId: fixture.owner, name: 'Synthetic', email: 'synthetic@example.test', active: true },
    ] } });
    if (url.pathname === '/api/inbox') return route.fulfill({ headers, json: {
      ownerId: fixture.owner, unread: 0, unresolved: 0, waitingApplications: 0,
      serverTime: Date.now(), items: [], nextCursor: null,
    } });
    if (fixture.auth !== 200) return route.fulfill({ status: fixture.auth, headers, json: { error: 'Sign in required.' } });
    const expectedApplicant = request.headers()['x-workie-applicant'];
    if ((expectedApplicant !== undefined || !['GET', 'HEAD'].includes(request.method())) && expectedApplicant !== fixture.owner) {
      return route.fulfill({ status: 403, headers, json: { error: 'Applicant session changed. Unlock the current account.' } });
    }
    if (url.pathname === '/api/profile/draft-key') return route.fulfill({ headers, json: { ownerId: fixture.owner, keyVersion: '1', key } });
    if (url.pathname === '/api/profile') {
      if (request.method() === 'GET') return route.fulfill({ headers, json: { revision: fixture.revision, profile: fixture.profile, ownerId: fixture.owner } });
      const body = request.postDataJSON();
      fixture.writes.push(body);
      if (fixture.mode === 'offline') return route.abort('failed');
      if (fixture.mode === 'conflict') return route.fulfill({ status: 409, headers, json: { error: 'Revision conflict.' } });
      const parsed = ProfileSaveSchema.safeParse(body);
      if (!parsed.success) return route.fulfill({ status: 400, headers, json: { error: 'Invalid profile.' } });
      const previous = acknowledgements.get(body.requestId);
      if (previous) return route.fulfill({ status: JSON.stringify(body) === JSON.stringify(previous.body) ? 200 : 409, headers, json: previous.ack });
      if (body.expectedRevision !== fixture.revision) return route.fulfill({ status: 409, headers, json: { error: 'Revision conflict.' } });
      fixture.profile = parsed.data.profile;
      fixture.revision++;
      const ack = { revision: fixture.revision, profile: fixture.profile, ownerId: fixture.owner };
      acknowledgements.set(body.requestId, { body, ack: structuredClone(ack) });
      return route.fulfill({ headers, json: ack });
    }
    if (url.pathname === '/api/auto-apply/policies') {
      if (request.method() === 'GET') { fixture.policyGets++; return route.fulfill({ headers, json: fixture.policy }); }
      const body = request.postDataJSON();
      fixture.policyWrites.push({ method: request.method(), body });
      const parsed = (request.method() === 'PATCH' ? PolicySaveSchema : PolicyCommandSchema).safeParse(body);
      if (!parsed.success) return route.fulfill({ status: 400, headers, json: { error: 'Invalid policy.' } });
      if (fixture.policyMode === 'offline') return route.abort('failed');
      await fixture.beforePolicyWrite?.();
      const prior = policyAcks.get(body.requestId);
      if (prior) return route.fulfill({ status: JSON.stringify(body) === JSON.stringify(prior.body) ? 200 : 409, headers, json: prior.ack });
      const policy = fixture.policy;
      if (body.expectedRevision !== policy.revision) return route.fulfill({ status: 409, headers, json: { error: 'Revision conflict.' } });
      if (request.method() === 'PATCH') {
        fixture.policy = { ...policy, policy: PolicySaveSchema.parse(body).policy, revision: policy.revision + 1,
          policyVersion: policy.policyVersion + 1, policyHash: 'a'.repeat(64), enabled: false,
          acceptedAt: null, acceptedPolicyVersion: null, acceptedPolicyHash: null };
      } else {
        if (body.action === 'enable' && (!policy.policyVersion || body.acceptedPolicyHash !== policy.policyHash ||
            profileEnablementIssues(fixture.profile).length || !policy.policy.actions.length ||
            !policy.policy.destinations.length || !policy.policy.countries.length ||
            (policy.policy.expiresAt && Date.parse(policy.policy.expiresAt) <= Date.now()))) {
          return route.fulfill({ status: 409, headers, json: { error: 'Choose a saved, valid, permitted policy and confirm identity first.' } });
        }
        fixture.policy = { ...policy, revision: policy.revision + 1, enabled: body.action === 'enable',
          acceptedPolicyVersion: body.action === 'enable' ? policy.policyVersion : null,
          acceptedPolicyHash: body.action === 'enable' ? policy.policyHash : null,
          acceptedAt: body.action === 'enable' ? '2026-09-20T12:00:00.000Z' : null };
      }
      const ack = structuredClone(fixture.policy);
      policyAcks.set(body.requestId, { body, ack });
      await fixture.afterPolicyWrite?.();
      if (fixture.policyMode === 'lost') return route.abort('failed');
      return route.fulfill({ headers, json: ack });
    }
    if (url.pathname === '/api/documents') {
      if (request.method() === 'GET') return route.fulfill({ status: fixture.documentListError ? 503 : 200, headers,
        json: fixture.documentListError ? { error: 'Document list unavailable.' } : { documents: fixture.documents, storage: fixture.storage } });
      if (fixture.documentError) return route.fulfill({ status: 503, headers, json: { error: 'Storage unavailable.' } });
      const body = request.postDataJSON();
      fixture.grantRequests.push(body.requestId);
      fixture.grantBodies.push(body);
      const prior = grants.get(body.requestId);
      if (prior) {
        if (JSON.stringify(prior.body) !== JSON.stringify(body) || prior.response.document.state !== 'pending') {
          return route.fulfill({ status: 409, headers, json: { error: 'Upload request already used or expired.' } });
        }
        return route.fulfill({ status: 201, headers, json: prior.response });
      }
      const documentId = id();
      const doc = { id: documentId, masterId: documentId, name: body.name, kind: body.kind, role: body.role ?? null,
        parentId: body.parentId ?? null, version: 1, mime: body.mime, size: body.size, sha256: null,
        state: 'pending', safetyCheck: 'pending', createdAt: '2026-09-20T12:00:00.000Z', downloadUrl: null };
      fixture.documents.push(doc);
      const grantId = id();
      const response = { document: doc, grantId, pathname: `documents/${documentId}`, uploadMode: 'local', uploadUrl: `/api/documents/uploads/${grantId}` };
      grants.set(body.requestId, { body, response });
      if (fixture.grantResponseLost) return route.abort('failed');
      return route.fulfill({ status: 201, headers, json: response });
    }
    const grant = [...grants.values()].find((grant) => url.pathname === grant.response.uploadUrl);
    if (grant && request.method() === 'PUT') {
      fixture.uploads++;
      expect(request.headers()['content-type']).toBe(grant.response.document.mime);
      const doc = grant.response.document;
      if (doc.state !== 'pending') return route.fulfill({ status: 409, headers, json: { error: 'Upload grant expired or already used.' } });
      if (fixture.uploadMode === 'unknown') return route.abort('failed');
      doc.state = fixture.uploadMode === 'rejected' ? 'rejected' : 'quarantined';
      doc.safetyCheck = fixture.uploadMode === 'rejected' ? 'rejected' : 'deferred';
      if (fixture.failListAfterUpload) fixture.documentListError = true;
      if (fixture.uploadMode === 'lost') return route.abort('failed');
      return route.fulfill({ status: fixture.uploadMode === 'rejected' ? 422 : 202, headers, json: { document: doc, ...(fixture.uploadMode === 'rejected' ? { error: 'Document failed safety checks.' } : {}) } });
    }
    if (/^\/api\/documents\/[^/]+\/validate$/.test(url.pathname)) {
      fixture.documents.at(-1)!.state = 'available';
      fixture.documents.at(-1)!.safetyCheck = 'passed';
      return route.fulfill({ headers, json: { document: fixture.documents.at(-1) } });
    }
    fixture.errors.push(`Unexpected fixture API: ${request.method()} ${url.pathname}`);
    return route.abort();
  });
  test.info().annotations.push({ type: 'evidence', description: 'Rendered UI proof with mocked APIs; no production/backend proof.' });
});

test.afterEach(async ({ page }) => {
  expect(fixtures.get(page)!.errors).toEqual([]);
});
async function ready(page: Page) {
  await page.goto('/profile');
  await expect(page.getByLabel('Legal first name', { exact: true })).toBeVisible();
  await expect(page.getByText('Checking applicant session...', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save policy', exact: true })).toBeVisible();
  await expect(page.getByText('No documents.', { exact: true })).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByRole('status').filter({ hasText: /^Saved \/ revision/ })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => Object.values(localStorage).every((v) => !v.includes('Synthetic') && !v.includes('synthetic@example.test')))).toBe(true);
}
async function sectionScreenshot(page: Page, info: TestInfo, section: Locator, name: string) {
  const brokenWords = await page.locator('table td:not(:first-child)').evaluateAll(cells => cells.flatMap(cell => {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    const broken: string[] = [];
    while (walker.nextNode()) {
      const text = walker.currentNode;
      for (const match of (text.textContent ?? '').matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(text, match.index); range.setEnd(text, match.index + match[0].length);
        if (range.getClientRects().length > 1) broken.push(match[0]);
      }
    }
    return broken;
  }));
  expect(brokenWords, 'Document status and action words must not break across lines').toEqual([]);
  // Fixed-viewport tiles avoid Chromium's blank tall-element captures on mobile.
  const bounds = await section.evaluate(element => {
    const box = element.getBoundingClientRect();
    return { top: box.top + scrollY, bottom: box.bottom + scrollY };
  });
  const height = info.project.use.viewport!.height;
  let tile = 0;
  for (let top = bounds.top; top < bounds.bottom; top += height - 80) {
    await page.evaluate(top => window.scrollTo({ top, behavior: 'instant' }), top);
    await page.screenshot({ path: info.outputPath(`${name}${tile ? `-${tile + 1}` : ''}.png`) });
    tile++;
  }
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const boxes = await page.locator('main input:visible, main select:visible, main button:visible, main textarea:visible')
    .evaluateAll(elements => elements.map(element => {
      const { x, width } = element.getBoundingClientRect();
      return { x, width, label: element.getAttribute('aria-label') ?? element.textContent };
    }));
  for (const box of boxes) {
    expect(box.x, box.label ?? '').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, box.label ?? '').toBeLessThanOrEqual(info.project.use.viewport!.width + 1);
  }
  await sectionScreenshot(page, info, name === 'nine-sections' ? page.locator('main') :
    page.getByRole('form', { name: 'Upload document' }).locator('..'), name);
}

test('all nine sections render native fields with responsive labels and keyboard focus', async ({ page }, info) => {
  await ready(page);
  for (const label of Object.values(PROFILE_SECTION_LABELS)) await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  await page.getByLabel('Legal first name', { exact: true }).focus();
  await expect(page.getByLabel('Legal first name', { exact: true })).toHaveCSS('outline-width', '2px');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Legal first name answer state')).toBeFocused();
  await page.getByRole('button', { name: 'Add schools entry', exact: true }).click();
  await page.getByLabel('School', { exact: true }).fill('Synthetic School');
  await page.getByLabel('Expected graduation precision').selectOption('month');
  await page.getByLabel('Expected graduation', { exact: true }).fill('2028-06');
  await page.getByLabel('GPA and scale: Value', { exact: true }).fill('3.5');
  await page.getByLabel('GPA and scale: Scale', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Add employment entry', exact: true }).click();
  await page.locator('#work').getByLabel('Employer', { exact: true }).fill('Synthetic Employer');
  await page.locator('#authorization').getByRole('button', { name: 'Add countries entry', exact: true }).click();
  await page.locator('#authorization').getByLabel('Country (2-letter code)', { exact: true }).fill('US');
  await page.getByLabel('Citizen of this country: No', { exact: true }).check();
  const citizenship = page.locator('[data-fact-path="authorization.countries.0.citizenship"]');
  await citizenship.locator('summary').click();
  await page.getByLabel('Citizen of this country scope: Kind', { exact: true }).selectOption('country');
  await page.getByLabel('Citizen of this country scope: Country (2-letter code)', { exact: true }).fill('US');
  await page.getByLabel('Residence status', { exact: true }).fill('Permanent resident');
  await page.locator('[data-fact-path="authorization.countries.0.residenceStatus"] summary').click();
  await page.getByLabel('Residence status scope: Kind', { exact: true }).selectOption('country');
  await page.getByLabel('Residence status scope: Country (2-letter code)', { exact: true }).fill('US');
  await page.getByLabel('Hours During Classes', { exact: true }).fill('20');
  await page.getByRole('button', { name: 'Add employer disclosures entry', exact: true }).click();
  await page.locator('#disclosures').getByLabel('Employer', { exact: true }).fill('Synthetic Employer');
  await page.getByLabel('Exact Question', { exact: true }).fill('Are you currently bound by a non-compete with this employer?');
  await page.getByLabel('Timeframe', { exact: true }).selectOption('current');
  await page.getByLabel('Gender answer state').selectOption('declined');
  await page.getByLabel('Pay Floor: Amount', { exact: true }).fill('25');
  await page.getByLabel('Pay Floor: Currency', { exact: true }).fill('USD');
  await page.getByLabel('Pay Floor: Period', { exact: true }).selectOption('hour');
  await page.getByLabel('Undisclosed Pay', { exact: true }).selectOption('ask');
  await page.getByLabel('Format Policy', { exact: true }).selectOption('preserve_exact');
  await page.getByLabel('Provider', { exact: true }).selectOption('local');
  await page.getByLabel('Privacy', { exact: true }).selectOption('local_inference_only');
  await saved(page);
  const data = fixtures.get(page)!.profile;
  expect(ProfileSchema.safeParse(data).success).toBe(true);
  expect(data.education.schools[0].expectedGraduation.value).toEqual({ precision: 'month', value: '2028-06' });
  expect(data.authorization.countries[0].citizenship.value).toBe(false);
  expect(data.voluntary.gender.state).toBe('declined');
  expect(data.preferences.payFloor.value).toEqual({ amount: 25, currency: 'USD', period: 'hour' });
  await screenshot(page, info, 'nine-sections');
});

test('optional states and candidates remain distinct; invalid values are editable', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.profile.voluntary.pronouns = { ...fixture.profile.voluntary.pronouns, state: 'candidate', value: 'synthetic candidate' };
  await ready(page);
  await expect(page.getByLabel('Pronouns answer state')).toHaveValue('candidate');
  expect(fixture.writes).toHaveLength(0);
  await page.getByLabel('Pronouns answer state').selectOption('confirmed');
  await page.getByLabel('Disability answer state').selectOption('declined');
  await page.getByLabel('Veteran answer state').selectOption('not_applicable');
  await page.getByLabel('Personal email', { exact: true }).fill('bad-email');
  await expect(page.getByText('Correct the marked fields before saving.')).toBeVisible();
  await page.getByLabel('Personal email', { exact: true }).fill('changed@example.test');
  await saved(page);
  expect(fixture.profile.voluntary.pronouns.state).toBe('confirmed');
  expect(fixture.profile.voluntary.disability.state).toBe('declined');
  expect(fixture.profile.voluntary.veteran.state).toBe('not_applicable');
  expect(fixture.profile.voluntary.raceEthnicity.state).toBe('unknown');
});

test('encrypted reload recovery retains failed request ID and newest input', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  fixture.mode = 'offline';
  await page.getByLabel('Preferred Name', { exact: true }).fill('Synthetic First');
  await expect(page.getByText('Network unavailable. Retry saving.')).toBeVisible();
  await page.getByLabel('Preferred Name', { exact: true }).fill('Synthetic Last');
  await expect.poll(() => page.evaluate(() => localStorage.length)).toBeGreaterThan(0);
  const values = await page.evaluate(() => Object.values(localStorage).join(''));
  expect(values).not.toContain('Synthetic Last');
  expect(values).not.toContain(key);
  expect(JSON.parse(await page.evaluate(() => Object.values(localStorage)[0]))).toMatchObject({ version: 1, ownerId: ownerA, keyVersion: '1' });
  await expect(page.getByRole('status').filter({ hasText: 'Encrypting draft...' })).toHaveCount(0);
  const original = fixture.writes[0];
  page.on('dialog', (dialog) => dialog.accept());
  await page.reload();
  await expect(page.getByRole('button', { name: 'Recover draft 1' })).toBeVisible();
  fixture.mode = 'ok';
  await page.getByRole('button', { name: 'Recover draft 1' }).click();
  await expect(page.getByRole('button', { name: 'Recover draft 1' })).toHaveCount(0);
  await saved(page);
  await expect(page.getByLabel('Preferred Name', { exact: true })).toHaveValue('Synthetic Last');
  expect(fixture.writes[1]).toEqual(original);
  expect(fixture.profile.identity.preferredName.value).toBe('Synthetic Last');
});

test('conflict keeps edits, shows server values, and saves only after review', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  fixture.mode = 'conflict';
  fixture.profile.identity.preferredName = confirmed(fixture.profile.identity.preferredName, 'Server version');
  fixture.revision = 5;
  await page.getByLabel('Preferred Name', { exact: true }).fill('My draft');
  await expect(page.getByRole('region', { name: 'Profile conflict' })).toContainText('Server version');
  await page.getByLabel('Preferred Name', { exact: true }).fill('Reviewed draft');
  expect(fixture.writes).toHaveLength(1);
  fixture.mode = 'ok';
  await page.getByRole('button', { name: 'Save reviewed draft' }).click();
  await saved(page);
  expect(fixture.writes[1].expectedRevision).toBe(5);
  expect(fixture.profile.identity.preferredName.value).toBe('Reviewed draft');
});

test('an original retry acknowledgement never replaces a newer server revision', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  fixture.mode = 'offline';
  await page.getByLabel('Preferred Name', { exact: true }).fill('Old committed request');
  await expect(page.getByText('Network unavailable. Retry saving.')).toBeVisible();
  const original = structuredClone(fixture.writes[0]);
  fixture.profile.identity.preferredName = confirmed(fixture.profile.identity.preferredName, 'Newer server profile');
  fixture.revision = 2;
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    expect(route.request().headers()['x-workie-applicant']).toBe(ownerA);
    expect(route.request().postDataJSON()).toEqual(original);
    await route.fulfill({ json: { revision: 1, ownerId: ownerA, profile: original.profile } });
  });
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Profile conflict' })).toContainText('Newer server profile');
  await expect(page.getByLabel('Preferred Name', { exact: true })).toHaveValue('Old committed request');
  await expect(page.getByRole('status').filter({ hasText: /^Saved \/ revision/ })).toHaveCount(0);
});

test('a switch after the client owner check locks the pane before the draft can be written', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  await page.route('**/api/profile', async (route) => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    expect(route.request().headers()['x-workie-applicant']).toBe(ownerA);
    fixture.owner = ownerB; fixture.profile = fixtureProfile();
    return route.fallback();
  });
  await page.getByLabel('Preferred Name', { exact: true }).fill('Private A draft');
  await expect(page.getByRole('button', { name: 'Unlock profile' })).toBeVisible();
  await expect(page.getByLabel('Preferred Name', { exact: true })).not.toBeVisible();
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.revision).toBe(0);
  expect(fixture.profile.identity.preferredName.value).toBeNull();
  await page.getByRole('button', { name: 'Unlock profile' }).click();
  await expect(page.getByLabel('Preferred Name', { exact: true })).toHaveValue('');
});

test('same-principal reauthentication preserves edits and principal change clears them', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  fixture.auth = 401;
  await page.getByLabel('Preferred Name', { exact: true }).fill('Private pending A');
  await expect(page.getByRole('button', { name: 'Unlock profile' })).toBeVisible();
  await expect(page.getByLabel('Preferred Name', { exact: true })).not.toBeVisible();
  fixture.auth = 200;
  await page.getByRole('button', { name: 'Unlock profile' }).click();
  await saved(page);
  await expect(page.getByLabel('Preferred Name', { exact: true })).toHaveValue('Private pending A');
  fixture.owner = ownerB; fixture.profile = fixtureProfile(); fixture.revision = 0;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Preferred Name', { exact: true })).toHaveValue('');
  await expect(page.getByText('Private pending A')).toHaveCount(0);
  expect(fixture.profile.identity.preferredName.value).toBeNull();
});

test('an account change during key unlock never reveals the prior profile', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  await page.route('**/api/profile/draft-key', async (route) => {
    fixture.owner = ownerB;
    await route.fulfill({ json: { ownerId: ownerB, keyVersion: '1', key } });
  });
  await page.goto('/profile');
  await expect(page.getByRole('button', { name: 'Unlock profile' })).toBeEnabled();
  await expect(page.getByLabel('Legal first name', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Account changed. Unlock again.')).toBeVisible();
  expect(fixture.writes).toHaveLength(0);
});

test('saving policy stays disabled; enable accepts its saved version exactly once', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await expect(page.getByLabel('Policy: Account Policy')).toHaveValue('skip_new_accounts');
  await expect(page.getByLabel('Policy: Privacy')).toHaveValue('local_inference_only');
  await expect(page.getByLabel('Policy: Per request')).toHaveValue('0');
  await page.getByLabel('Policy: Actions: Read jobs', { exact: true }).check();
  await page.getByRole('button', { name: 'Add policy: destinations entry', exact: true }).click();
  await page.getByLabel('Policy: Destinations 1', { exact: true }).fill('employer.example.test');
  await page.getByRole('button', { name: 'Add policy: countries entry', exact: true }).click();
  await page.getByLabel('Policy: Countries 1', { exact: true }).fill('US');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy version 1 saved. Auto Apply disabled.')).toBeVisible();
  expect(fixture.policyWrites.map((w) => w.method)).toEqual(['PATCH']);
  await page.getByLabel('Accept policy version 1').check();
  await page.getByRole('button', { name: 'Enable Auto Apply', exact: true }).click();
  await expect(page.getByText('Policy version 1 accepted. Runner offline.')).toBeVisible();
  expect(fixture.policyWrites[1]).toMatchObject({ method: 'POST', body: { action: 'enable', acceptedPolicyHash: 'a'.repeat(64) } });
  await page.getByRole('button', { name: 'Disable Auto Apply', exact: true }).click();
  await expect(page.getByText('Policy version 1 saved. Auto Apply disabled.')).toBeVisible();
  expect(fixture.policyWrites[2]).toMatchObject({ method: 'POST', body: { action: 'disable' } });
});

test('private uploads retain input after error and quarantine is not availability', async ({ page }, info) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Upload file (up to 10 MB)').setInputFiles({ name: 'synthetic-resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nUI FIXTURE ONLY\n%%EOF') });
  await page.getByLabel('Target role', { exact: true }).fill('Synthetic engineer');
  fixture.documentError = true;
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByText(/Your selection is retained/, { exact: false })).toBeVisible();
  expect(await page.getByLabel('Upload file (up to 10 MB)').evaluate((input: HTMLInputElement) => input.files?.length)).toBe(1);
  fixture.documentError = false;
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveCount(0);
  expect(fixture.uploads).toBe(1);
  await page.getByRole('button', { name: 'Retry validation' }).click();
  await expect(page.getByRole('link', { name: 'Download', exact: true })).toHaveAttribute('href', new RegExp('^/api/documents/[^/]+/download$'));
  expect(await page.evaluate(() => Object.values(localStorage).join(''))).not.toContain('UI FIXTURE ONLY');
  await screenshot(page, info, 'document-available');
});

test('portfolio artwork accepts PNG and requests a portfolio upload grant', async ({ page }) => {
  await ready(page);
  const fixture = fixtures.get(page)!;
  await page.getByLabel('Document kind', { exact: true }).selectOption('portfolio');
  await expect(page.getByLabel('Upload file (up to 10 MB)')).toHaveAttribute('accept', 'application/pdf,image/png,image/jpeg');
  await page.getByLabel('Upload file (up to 10 MB)').setInputFiles({
    name: 'synthetic-portfolio.png', mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]),
  });
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
  expect(fixture.grantBodies).toHaveLength(1);
  expect(fixture.grantBodies[0]).toMatchObject({ kind: 'portfolio', mime: 'image/png', name: 'synthetic-portfolio.png' });
});

test('unconfigured storage is actionable and does not clear the selected file', async ({ page }) => {
  fixtures.get(page)!.storage = 'unconfigured';
  await ready(page);
  await page.getByLabel('Upload file (up to 10 MB)').setInputFiles({ name: 'synthetic.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic') });
  await expect(page.getByText('Document storage is not configured. Configure private local storage or Vercel Blob before uploading.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Upload document', exact: true })).toBeDisabled();
  expect(await page.getByLabel('Upload file (up to 10 MB)').evaluate((input: HTMLInputElement) => input.files?.length)).toBe(1);
});

test('historical policy enable acknowledgement cannot override a newer disabled head', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  fixture.policy = savedPolicy();
  await ready(page);
  fixture.policyMode = 'lost';
  await page.getByLabel('Accept policy version 1').check();
  await page.getByRole('button', { name: 'Enable Auto Apply', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry policy request' })).toBeVisible();
  const original = structuredClone(fixture.policyWrites[0]);
  // Another tab disables the same saved policy after the lost enable acknowledgement.
  fixture.policy = { ...fixture.policy, revision: 3, enabled: false, acceptedPolicyVersion: null, acceptedPolicyHash: null, acceptedAt: null };
  const reads = fixture.policyGets;
  fixture.policyMode = 'ok';
  await page.getByRole('button', { name: 'Retry policy request' }).click();
  await expect(page.locator('#auto-apply-policy')).toContainText('Earlier request acknowledged. Current policy version 1: Auto Apply disabled.');
  expect(fixture.policyWrites[1]).toEqual(original);
  expect(fixture.policyGets).toBeGreaterThan(reads);
  await expect(page.getByText('Enabled intent / Runner offline', { exact: true })).toHaveCount(0);
  await sectionScreenshot(page, info, page.locator('#auto-apply-policy'), 'historical-policy-disabled');
});

for (const action of ['enable', 'disable'] as const) {
  test(`retried policy ${action} acknowledgement preserves a newer editable draft`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    fixture.policy = savedPolicy(action === 'disable');
    await ready(page);
    fixture.policyMode = 'lost';
    if (action === 'enable') await page.getByLabel('Accept policy version 1').check();
    await page.getByRole('button', { name: action === 'enable' ? 'Enable Auto Apply' : 'Disable Auto Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry policy request' })).toBeVisible();
    const original = structuredClone(fixture.policyWrites[0]);
    await page.getByLabel('Policy: Daily Application Cap', { exact: true }).fill('37');
    fixture.policyMode = 'ok';
    await page.getByRole('button', { name: 'Retry policy request' }).click();
    await expect(page.getByRole('button', { name: 'Retry policy request' })).toHaveCount(0);
    await expect(page.getByLabel('Policy: Daily Application Cap', { exact: true })).toHaveValue('37');
    expect(fixture.policyWrites[1]).toEqual(original);
    expect(fixture.policy.policy.dailyApplicationCap).toBe(10);
    await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    await expect(page.getByText('Policy version 2 saved. Auto Apply disabled.')).toBeVisible();
    expect(fixture.policy.policy.dailyApplicationCap).toBe(37);
  });
}

for (const pending of ['enable', 'save'] as const) {
  test(`explicit disable cancels uncertain ${pending} intent without replaying it`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    fixture.policy = savedPolicy(pending === 'save');
    await ready(page);
    fixture.policyMode = 'lost';
    if (pending === 'enable') {
      await page.getByLabel('Accept policy version 1').check();
      await page.getByRole('button', { name: 'Enable Auto Apply', exact: true }).click();
    } else {
      await page.getByLabel('Policy: Daily Application Cap', { exact: true }).fill('20');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
    }
    await expect(page.getByRole('button', { name: 'Retry policy request' })).toBeVisible();
    await page.getByLabel('Policy: Daily Application Cap', { exact: true }).fill('38');
    const revision = fixture.policy.revision;
    fixture.policyMode = 'ok';
    await expect(page.getByRole('button', { name: 'Disable Auto Apply', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Disable Auto Apply', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Retry policy request' })).toHaveCount(0);
    await expect(page.getByLabel('Policy: Daily Application Cap', { exact: true })).toHaveValue('38');
    expect(fixture.policyWrites).toHaveLength(2);
    expect(fixture.policyWrites[1]).toMatchObject({ method: 'POST', body: { action: 'disable', expectedRevision: revision } });
    expect(fixture.policy.enabled).toBe(false);
    expect(fixture.policy.policy.dailyApplicationCap).toBe(pending === 'save' ? 20 : 10);
  });
}

for (const timing of ['before commit', 'after commit'] as const) {
  test(`disable fences a delayed enable ${timing} and cannot stomp a newer save`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    fixture.policy = savedPolicy();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hook = timing === 'before commit' ? 'beforePolicyWrite' : 'afterPolicyWrite';
    fixture[hook] = async () => { fixture[hook] = undefined; await gate; };
    try {
      await ready(page);
      await page.getByLabel('Accept policy version 1').check();
      await page.getByRole('button', { name: 'Enable Auto Apply', exact: true }).click();
      await expect.poll(() => fixture.policyWrites.length).toBe(1);
      if (timing === 'after commit') await expect.poll(() => fixture.policy.enabled).toBe(true);
      await expect(page.getByRole('button', { name: 'Disable Auto Apply', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Disable Auto Apply', exact: true }).click();
      await expect(page.getByText('Policy version 1 saved. Auto Apply disabled.')).toBeVisible();
      await page.getByLabel('Policy: Daily Application Cap', { exact: true }).fill('39');
      await page.getByRole('button', { name: 'Save policy', exact: true }).click();
      await expect(page.getByText('Policy version 2 saved. Auto Apply disabled.')).toBeVisible();
      const completed = page.waitForResponse((response) => response.url().endsWith('/api/auto-apply/policies') &&
        response.request().method() === 'POST' && response.request().postDataJSON().action === 'enable');
      release();
      await completed;
      await expect(page.getByLabel('Policy: Daily Application Cap', { exact: true })).toHaveValue('39');
      await expect(page.getByText('Policy version 2 saved. Auto Apply disabled.')).toBeVisible();
      expect(fixture.policy.enabled).toBe(false);
      expect(fixture.policy.policy.dailyApplicationCap).toBe(39);
      expect(fixture.policyWrites.map((write) => write.body.action ?? 'save')).toEqual(['enable', 'disable', 'save']);
    } finally { release(); }
  });
}

test('disable retries only its CAS when an older enable commits between head read and disable', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.policy = savedPolicy();
  await ready(page);
  fixture.beforePolicyWrite = async () => {
    fixture.beforePolicyWrite = undefined;
    fixture.policy = savedPolicy(true);
  };
  await page.getByRole('button', { name: 'Disable Auto Apply', exact: true }).click();
  await expect(page.getByText('Policy version 1 saved. Auto Apply disabled.')).toBeVisible();
  expect(fixture.policyWrites.map((write) => write.body.action)).toEqual(['disable', 'disable']);
  expect(fixture.policyWrites.map((write) => write.body.expectedRevision)).toEqual([1, 2]);
  expect(fixture.policy.enabled).toBe(false);
});

for (const missing of ['actions', 'destinations', 'countries'] as const) {
  test(`enable rejects a saved policy with empty ${missing}`, async ({ page }) => {
    const fixture = fixtures.get(page)!;
    fixture.policy = savedPolicy();
    fixture.policy.policy[missing] = [];
    await ready(page);
    await page.getByLabel('Accept policy version 1').check();
    await page.getByRole('button', { name: 'Enable Auto Apply', exact: true }).click();
    await expect(page.getByText('A newer version exists. Review before saving.', { exact: true })).toBeVisible();
    expect(fixture.policy.enabled).toBe(false);
    expect(fixture.policy.revision).toBe(1);
    await expect(page.getByText('Enabled intent / Runner offline', { exact: true })).toHaveCount(0);
  });
}

test('clearing optional address line 2 saves an empty string while nullable facts clear to null', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.profile.identity.currentAddress = confirmed(fixture.profile.identity.currentAddress,
    { line1: '123 Synthetic St', line2: 'Unit 4', city: 'Test City', region: 'CA', postalCode: '90000', country: 'US' });
  fixture.profile.identity.preferredName = confirmed(fixture.profile.identity.preferredName, 'Optional');
  await ready(page);
  await page.getByLabel('Current Address: Address line 2', { exact: true }).fill('');
  await page.getByLabel('Preferred Name', { exact: true }).fill('');
  await saved(page);
  expect(fixture.profile.identity.currentAddress.value?.line2).toBe('');
  expect(fixture.profile.identity.preferredName.value).toBeNull();
  expect(fixture.profile.identity.preferredName.state).toBe('unknown');
  expect(ProfileSchema.safeParse(fixture.profile).success).toBe(true);
});

test('nullable policy pay floor has a typed clear control and saves null', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  fixture.policy = savedPolicy();
  await ready(page);
  await page.getByLabel('Policy: Pay Floor: Amount', { exact: true }).fill('28');
  await page.getByLabel('Policy: Pay Floor: Currency', { exact: true }).fill('USD');
  await page.getByLabel('Policy: Pay Floor: Period', { exact: true }).selectOption('hour');
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy version 2 saved. Auto Apply disabled.')).toBeVisible();
  expect(fixture.policy.policy.payFloor).toEqual({ amount: 28, currency: 'USD', period: 'hour' });
  await page.getByRole('button', { name: 'Clear Policy: Pay Floor', exact: true }).click();
  await page.getByRole('button', { name: 'Save policy', exact: true }).click();
  await expect(page.getByText('Policy version 3 saved. Auto Apply disabled.')).toBeVisible();
  expect(fixture.policy.policy.payFloor).toBeNull();
  await sectionScreenshot(page, info, page.locator('#auto-apply-policy'), 'nullable-policy-pay-floor');
});

test('reversed employment dates show the exact entry error with focus links until corrected', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  await page.getByRole('button', { name: 'Add employment entry', exact: true }).click();
  const work = page.locator('#work');
  await work.getByLabel('Start', { exact: true }).fill('2026-06');
  await work.getByLabel('End', { exact: true }).fill('2025-06');
  const alert = work.getByRole('alert').filter({ hasText: 'Work dates are reversed.' });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeDisabled();
  await alert.getByRole('link', { name: 'End', exact: true }).click();
  await expect(work.getByLabel('End', { exact: true })).toBeFocused();
  await sectionScreenshot(page, info, work, 'employment-cross-field-error');
  await work.getByLabel('End', { exact: true }).fill('2026-09');
  await saved(page);
  await expect(alert).toHaveCount(0);
  expect(fixture.profile.work.employment[0].end.value).toEqual({ precision: 'month', value: '2026-09' });
});

test('weekly onsite and remote days show the exact section error with keyboard focus links', async ({ page }, info) => {
  const fixture = fixtures.get(page)!;
  await ready(page);
  await page.getByLabel('Onsite Days', { exact: true }).fill('5');
  await page.getByLabel('Remote Days', { exact: true }).fill('4');
  const alert = page.locator('#availability').getByRole('alert').filter({ hasText: 'Weekly onsite and remote days cannot exceed seven.' });
  await expect(alert).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry save', exact: true })).toBeDisabled();
  await alert.getByRole('link', { name: 'Remote Days', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Remote Days', { exact: true })).toBeFocused();
  await sectionScreenshot(page, info, page.locator('#availability'), 'availability-cross-field-error');
  await page.getByLabel('Remote Days', { exact: true }).fill('2');
  await saved(page);
  await expect(alert).toHaveCount(0);
  expect(fixture.profile.availability.remoteDays.value).toBe(2);
});

async function chooseDocument(page: Page) {
  await page.getByLabel('Upload file (up to 10 MB)').setInputFiles({
    name: 'synthetic-resume.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.7\nUI FIXTURE ONLY\n%%EOF'),
  });
}
const selectedFiles = (page: Page) => page.getByLabel('Upload file (up to 10 MB)').evaluate((input: HTMLInputElement) => input.files?.length);

for (const retry of ['Retry upload', 'Refresh documents'] as const) {
  test(`successful PUT and failed list refresh reconcile through ${retry} without reusing a consumed grant`, async ({ page }, info) => {
    const fixture = fixtures.get(page)!;
    await ready(page);
    fixture.failListAfterUpload = true;
    await chooseDocument(page);
    await page.getByRole('button', { name: 'Upload document', exact: true }).click();
    await expect(page.getByText('Upload received, but the document list could not refresh. Refresh documents or retry status; bytes will not be uploaded again.')).toBeVisible();
    expect(await selectedFiles(page)).toBe(1);
    fixture.documentListError = false;
    await page.getByRole('button', { name: retry, exact: true }).click();
    await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toHaveCount(0);
    expect(await selectedFiles(page)).toBe(0);
    expect(fixture.uploads).toBe(1);
    expect(fixture.grantRequests).toHaveLength(1);
    await sectionScreenshot(page, info, page.getByRole('form', { name: 'Upload document' }).locator('..'), 'upload-reconciled');
  });
}

test('lost PUT acknowledgement reconciles the known document without resending bytes', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.uploadMode = 'lost';
  await ready(page);
  await chooseDocument(page);
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toHaveCount(0);
  expect(fixture.uploads).toBe(1);
  expect(await selectedFiles(page)).toBe(0);
});

test('unknown upload outcome retains the file and waits for its own status before a fresh expired grant', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.uploadMode = 'unknown';
  await ready(page);
  await chooseDocument(page);
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByText('Upload outcome is unknown. Your selection is retained; refresh status before retrying.')).toBeVisible();
  const own = fixture.documents[0];
  fixture.documents.push({ ...own, id: id(), name: 'unrelated.pdf', state: 'available', safetyCheck: 'passed' });
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page.getByText('Upload outcome is not yet known. Refresh documents to check again; no bytes have been resent.')).toBeVisible();
  expect(fixture.uploads).toBe(1);
  expect(await selectedFiles(page)).toBe(1);
  own.state = 'expired';
  await page.getByRole('button', { name: 'Refresh documents', exact: true }).click();
  await expect(page.getByText('Upload expired. Your selection is retained for a new upload.')).toBeVisible();
  expect(await selectedFiles(page)).toBe(1);
  fixture.uploadMode = 'ok';
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
  expect(new Set(fixture.grantRequests).size).toBe(2);
  expect(fixture.uploads).toBe(2);
});

test('lost grant response retries the same idempotent request before uploading once', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.grantResponseLost = true;
  await ready(page);
  await chooseDocument(page);
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toBeEnabled();
  expect(fixture.documents).toHaveLength(1);
  fixture.grantResponseLost = false;
  await page.getByRole('button', { name: 'Retry upload', exact: true }).click();
  await expect(page.getByRole('cell', { name: /Quarantined/ })).toBeVisible();
  expect(fixture.documents).toHaveLength(1);
  expect(fixture.grantRequests).toHaveLength(2);
  expect(new Set(fixture.grantRequests).size).toBe(1);
  expect(fixture.uploads).toBe(1);
});

test('consumed rejected upload retires pending intent but retains the selected file', async ({ page }) => {
  const fixture = fixtures.get(page)!;
  fixture.uploadMode = 'rejected';
  await ready(page);
  await chooseDocument(page);
  await page.getByRole('button', { name: 'Upload document', exact: true }).click();
  await expect(page.getByText('Document rejected. Choose a new file.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry upload', exact: true })).toHaveCount(0);
  expect(await selectedFiles(page)).toBe(1);
  expect(fixture.uploads).toBe(1);
});
