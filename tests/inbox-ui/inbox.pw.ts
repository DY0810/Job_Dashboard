import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { AnswerCommandSchema, type QuestionField } from '../../lib/applications/question-protocol';
import { baseField, fixture, id, ownerB, question } from './fixtures';

const fixtures = new WeakMap<Page, ReturnType<typeof fixture>>();
test.beforeEach(async ({ page, context, baseURL }) => {
  const f = fixture();
  fixtures.set(page, f);
  const origin = new URL(baseURL!).origin;
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) { await route.abort('blockedbyclient'); return; }
    if (!url.pathname.startsWith('/api/')) { await route.continue(); return; }
    if (url.pathname === '/api/notes') { await route.fulfill({ json: [] }); return; }
    try {
      const result = await f.respond(`${url.pathname}${url.search}`, request.method(),
        request.postData() ? request.postDataJSON() : undefined, new Headers(request.headers()));
      await route.fulfill({ status: result.status, json: result.json, headers: { 'cache-control': 'private, no-store' } });
    } catch { await route.abort('connectionfailed'); }
  });
  // Real requests are blocked above. Reloading intentionally retains encrypted local drafts.
  page.on('dialog', (dialog) => void dialog.accept());
});
const inbox = (page: Page) => page.getByRole('dialog', { name: 'Private inbox', exact: true });
const main = (page: Page) => page.getByRole('main');
async function open(page: Page, path = '/sign-in') {
  await page.goto(path);
  await main(page).getByRole('button', { name: /^Notification inbox:/ }).click();
  await expect(inbox(page)).toBeVisible();
  await expect(inbox(page).getByText('1 unread / 1 unresolved / 2 applications waiting', { exact: true })).toBeVisible();
}
async function current(page: Page, path = '/sign-in') {
  await open(page, path);
  await inbox(page).getByRole('button', { name: 'Open question', exact: true }).click();
  await expect(inbox(page).getByRole('form', { name: 'Answer question' })).toBeVisible();
}
async function capture(page: Page, info: TestInfo, name: string) {
  const dialog = inbox(page);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}
async function edit(page: Page, text: string) {
  await inbox(page).getByRole('form', { name: 'Answer question' }).getByRole('textbox').fill(text);
}

test('native modal traps keyboard focus, closes with Escape and returns focus to the icon bell', async ({ page }, info) => {
  await open(page);
  await expect(inbox(page).getByRole('button', { name: 'Close inbox' })).toBeFocused();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await inbox(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  await capture(page, info, 'inbox-list');
  await page.keyboard.press('Escape');
  await expect(inbox(page)).not.toBeVisible();
  await expect(main(page).getByRole('button', { name: /^Notification inbox:/ })).toBeFocused();
});

test('mark read changes unread only and opening never resumes work', async ({ page }) => {
  await open(page);
  const f = fixtures.get(page)!;
  expect(f.state.writes).toHaveLength(0);
  await inbox(page).getByRole('button', { name: 'Mark read', exact: true }).click();
  await expect(inbox(page).getByText('0 unread / 1 unresolved / 2 applications waiting', { exact: true })).toBeVisible();
  await expect.poll(() => f.state.writes.length).toBe(1);
  expect(f.state.resumes).toBe(0);
  expect(f.state.writes[0].path).toBe('/api/inbox/read');
});

test('reload recovers latest encrypted draft and exact lost answer request without automatic replay', async ({ page }, info) => {
  const f = fixtures.get(page)!;
  await current(page);
  await edit(page, 'first private response');
  f.state.answerMode = 'lost';
  await inbox(page).getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  const original = structuredClone(f.state.writes[0]);
  const beforeEdit = await page.evaluate(() => Object.values(localStorage).join(''));
  await edit(page, 'newer private response');
  await expect.poll(async () => page.evaluate(() => Object.values(localStorage).join(''))).toContain('ciphertext');
  await expect.poll(async () => page.evaluate(() => Object.values(localStorage).join(''))).not.toBe(beforeEdit);
  const stored = await page.evaluate(() => Object.values(localStorage).join(''));
  expect(stored).not.toContain('private response');
  await page.reload();
  await main(page).getByRole('button', { name: /^Notification inbox:/ }).click();
  await inbox(page).getByRole('button', { name: 'Recover inbox draft 1' }).click();
  expect(f.state.writes).toHaveLength(1);
  f.state.answerMode = 'ok';
  await inbox(page).getByRole('button', { name: 'Retry pending request' }).click();
  await expect(inbox(page).getByRole('status').filter({ hasText: 'Your newer edit is retained and was not sent.' })).toBeVisible();
  expect(f.state.writes[1]).toEqual(original);
  expect(f.state.resumes).toBe(1); // Synthetic transport count, not backend resume proof.
  expect(f.state.writes).toHaveLength(2);
  await inbox(page).getByRole('button', { name: 'Open question', exact: true }).click();
  await expect(inbox(page).getByRole('textbox')).toHaveValue('newer private response');
  await expect(inbox(page).getByRole('button', { name: 'Save updated answer', exact: true })).toBeDisabled();
  await inbox(page).getByRole('button', { name: 'Use reviewed current question' }).click();
  await expect(inbox(page).getByRole('button', { name: 'Save updated answer', exact: true })).toBeEnabled();
  expect(f.state.writes).toHaveLength(2);
  await inbox(page).getByRole('button', { name: 'Save updated answer', exact: true }).click();
  await expect.poll(() => f.state.writes.length).toBe(3);
  expect(f.state.writes).toHaveLength(3);
  await capture(page, info, 'reload-newer-edit');
});

test('offline retry preserves original answer while a newer edit remains unsent', async ({ page }) => {
  const f = fixtures.get(page)!;
  await current(page);
  f.state.answerMode = 'offline';
  await edit(page, 'first');
  await inbox(page).getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  const original = structuredClone(f.state.writes[0]);
  await edit(page, 'last');
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  await expect(main(page).getByRole('alert').filter({ hasText: 'Offline.' })).toBeVisible();
  await expect(inbox(page).getByText('1 unread / 1 unresolved / 2 applications waiting', { exact: true })).toBeVisible();
  f.state.answerMode = 'ok';
  await inbox(page).getByRole('button', { name: 'Retry pending request' }).click();
  await expect.poll(() => f.state.writes.length).toBe(2);
  expect(f.state.writes[1]).toEqual(original);
  await expect(inbox(page).getByRole('textbox')).toHaveValue('last');
});

test('same-owner reauthentication and draft key rotation retain pending IDs and current input', async ({ page }) => {
  const f = fixtures.get(page)!;
  await current(page);
  f.state.answerMode = 'offline';
  await edit(page, 'first');
  await inbox(page).getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Retry pending request' })).toBeEnabled();
  const original = structuredClone(f.state.writes[0]);
  await edit(page, 'latest');
  f.state.auth = 401;
  await inbox(page).getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect(inbox(page).getByRole('button', { name: 'Unlock inbox' })).toBeVisible();
  f.state.auth = 200; f.state.keyVersion = '2';
  await inbox(page).getByRole('button', { name: 'Unlock inbox' }).click();
  await expect(inbox(page).getByRole('textbox')).toHaveValue('latest');
  f.state.answerMode = 'ok';
  await inbox(page).getByRole('button', { name: 'Retry pending request' }).click();
  await expect.poll(() => f.state.writes.length).toBe(2);
  expect(f.state.writes[1]).toEqual(original);
});

test('principal change clears all applicant text and current controls', async ({ page }) => {
  const f = fixtures.get(page)!;
  await current(page);
  await edit(page, 'private owner A text');
  f.state.owner = ownerB;
  await inbox(page).getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(inbox(page).getByText('No notifications.', { exact: true })).toBeVisible();
  await expect(inbox(page).getByRole('textbox')).toHaveCount(0);
  expect(await inbox(page).textContent()).not.toContain('Synthetic Employer');
  expect(f.state.writes).toHaveLength(0);
});

test('scope and schema changes require explicit review and remove stale wider reuse', async ({ page }, info) => {
  const f = fixtures.get(page)!;
  f.state.q.allowedReuse = ['application', 'employer'];
  await current(page);
  await edit(page, 'my answer');
  await inbox(page).getByRole('combobox', { name: 'Use answer for' }).selectOption('employer');
  f.state.q = { ...f.state.q, revision: 2, expectedScopeHash: 'b'.repeat(64), allowedReuse: ['application'] };
  await inbox(page).getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(main(page).getByRole('alert').filter({ hasText: 'The question, options, profile or policy changed.' })).toBeVisible();
  await expect(inbox(page).getByRole('button', { name: 'Save answer', exact: true })).toBeDisabled();
  await inbox(page).getByRole('button', { name: 'Use reviewed current question' }).click();
  await expect(inbox(page).getByRole('combobox', { name: 'Use answer for' })).toHaveValue('application');
  await expect(inbox(page).getByRole('textbox')).toHaveValue('my answer');
  expect(f.state.writes).toHaveLength(0);
  await capture(page, info, 'scope-review');
});

test('server answer eligibility renders read-only or an explicit updated-answer command', async ({ page }) => {
  const f = fixtures.get(page)!;
  f.state.q.canAnswer = false;
  await current(page);
  await expect(inbox(page).getByRole('status').filter({ hasText: 'This question is read-only.' })).toBeVisible();
  await expect(inbox(page).getByRole('button', { name: 'Save answer', exact: true })).toBeDisabled();

  f.state.q = { ...f.state.q, canAnswer: true, resolved: true, waitingCount: 0 };
  await inbox(page).getByRole('button', { name: 'Refresh inbox', exact: true }).click();
  await expect(inbox(page).getByRole('status').filter({ hasText: 'You can save an updated answer.' })).toBeVisible();
  await expect(inbox(page).getByRole('button', { name: 'Save updated answer', exact: true })).toBeEnabled();
  expect(f.state.writes).toHaveLength(0);
});

test('error retains nonzero counts and signed-out bell offers sign-in without affecting public content', async ({ page }, info) => {
  const f = fixtures.get(page)!;
  await open(page, '/');
  f.state.inboxError = true;
  await inbox(page).getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(main(page).getByRole('alert').filter({ hasText: 'Private inbox unavailable' })).toBeVisible();
  await expect(inbox(page).getByText('1 unread / 1 unresolved / 2 applications waiting', { exact: true })).toBeVisible();
  f.state.auth = 401;
  await inbox(page).getByRole('button', { name: 'Refresh inbox' }).click();
  await expect(inbox(page).getByRole('link', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(inbox(page).getByText('Counts unavailable', { exact: true })).toBeVisible();
  await capture(page, info, 'signed-out-inbox');
  await page.keyboard.press('Escape');
  await expect(main(page).getByRole('button', { name: /^Notification inbox:/ })).toBeVisible();
});

for (const kind of ['needs_login', 'needs_verification'] as const) {
  test(`${kind} requests correct paired browser focus without claiming completion`, async ({ page }, info) => {
    const f = fixtures.get(page)!;
    f.state.q = question({ ...baseField, type: 'intervention' }, kind);
    await open(page);
    await inbox(page).getByRole('button', { name: 'Open question' }).click();
    await expect(inbox(page).getByText('Host: employer.example.test / synthetic-ats', { exact: true })).toBeVisible();
    await inbox(page).getByRole('button', { name: 'Focus paired browser' }).click();
    await expect(inbox(page).getByRole('status').filter({ hasText: 'Completion still requires worker observation.' })).toBeVisible();
    await expect(inbox(page).getByRole('button', { name: 'Save answer', exact: true })).toHaveCount(0);
    expect(f.state.resumes).toBe(0);
    await expect.poll(() => f.state.writes.length).toBe(1);
    expect(f.state.writes).toHaveLength(1);
    expect(f.state.writes[0].path).toBe(`/api/questions/${f.state.q.id}/focus`);
    await capture(page, info, kind);
  });
}

const typed: { name: string; field: QuestionField; value: string; answer: object }[] = [
  { name: 'text', field: { ...baseField, type: 'text', minLength: 1, maxLength: 300, format: 'email' }, value: 'synthetic@example.test', answer: { type: 'text', value: 'synthetic@example.test' } },
  { name: 'textarea', field: { ...baseField, type: 'textarea', minLength: 1, maxLength: 1000, format: 'plain' }, value: 'Confirmed synthetic context.', answer: { type: 'text', value: 'Confirmed synthetic context.' } },
  { name: 'number-units', field: { ...baseField, type: 'number', min: 0, max: 40, precision: 1, units: 'hours/week', integer: false }, value: '12.5', answer: { type: 'number', value: 12.5, precision: 1, units: 'hours/week' } },
  ...(['year', 'month', 'day'] as const).map((precision) => ({
    name: `date-${precision}`, field: { ...baseField, type: 'date' as const, precision, min: null, max: null },
    value: precision === 'year' ? '2027' : precision === 'month' ? '2027-05' : '2027-05-10',
    answer: { type: 'date', value: precision === 'year' ? '2027' : precision === 'month' ? '2027-05' : '2027-05-10', precision },
  })),
];
for (const item of typed) test(`${item.name} submits the actual protocol value inside the bell`, async ({ page }, info) => {
  const f = fixtures.get(page)!;
  f.state.q = question(item.field);
  await current(page);
  const form = inbox(page).getByRole('form', { name: 'Answer question' });
  await form.locator(`#answer-${f.state.q.id}`).fill(item.value);
  await capture(page, info, item.name);
  await form.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('status').filter({ hasText: 'Answer acknowledged.' })).toBeVisible();
  expect(AnswerCommandSchema.parse(f.state.writes[0].body).answer).toEqual(item.answer);
});

for (const type of ['radio', 'select', 'multiselect', 'boolean'] as const) {
  test(`${type} preserves original option values`, async ({ page }) => {
    const f = fixtures.get(page)!;
    f.state.q = question(type === 'boolean' ? { ...baseField, type } : {
      ...baseField, type, options: [{ label: 'School address', value: 'school' }, { label: 'Personal address', value: 'personal' }],
      minSelections: 1, maxSelections: type === 'multiselect' ? 2 : 1,
    });
    await current(page);
    const form = inbox(page).getByRole('form', { name: 'Answer question' });
    if (type === 'select') await form.getByRole('combobox', { name: f.state.q.descriptor.originalWording }).selectOption('school');
    else await form.getByRole(type === 'multiselect' ? 'checkbox' : 'radio', { name: type === 'boolean' ? 'Yes' : 'School address', exact: true }).check();
    await form.getByRole('button', { name: 'Save answer', exact: true }).click();
    await expect(inbox(page).getByRole('status').filter({ hasText: 'Answer acknowledged.' })).toBeVisible();
    expect(AnswerCommandSchema.parse(f.state.writes[0].body).answer).toEqual(type === 'boolean' ?
      { type: 'boolean', value: true } : type === 'multiselect' ? { type: 'choices', value: ['school'] } : { type: 'choice', value: 'school' });
  });
}

test('document selector excludes unavailable versions and upload labels remain unique beside Profile', async ({ page }, info) => {
  const f = fixtures.get(page)!;
  f.state.q = question({ ...baseField, type: 'document', documentKinds: ['transcript'], mimeTypes: ['application/pdf'], maxBytes: 1000 }, 'needs_document');
  const doc = { id: id(), kind: 'transcript', name: 'synthetic-transcript.pdf', role: null, parentId: null, masterId: id(),
    version: 3, mime: 'application/pdf', size: 100, sha256: 'd'.repeat(64), state: 'available', safetyCheck: 'passed', createdAt: '2026-09-21T00:00:00Z' };
  f.state.documents = [doc, { ...doc, id: id(), name: 'quarantined.pdf', state: 'quarantined' }];
  await page.goto('/profile');
  await expect(main(page).locator('#document-file')).toHaveCount(1);
  await main(page).getByRole('button', { name: /^Notification inbox:/ }).click();
  await inbox(page).getByRole('button', { name: 'Open question' }).click();
  const form = inbox(page).getByRole('form', { name: 'Answer question' });
  const select = form.getByRole('combobox', { name: f.state.q.descriptor.originalWording });
  await expect(select.getByRole('option', { name: 'synthetic-transcript.pdf / v3' })).toHaveCount(1);
  await expect(select.getByRole('option', { name: /quarantined/ })).toHaveCount(0);
  const input = inbox(page).getByRole('form', { name: 'Upload document' }).getByLabel('Upload file (up to 10 MB)', { exact: true });
  await expect(input).toHaveAttribute('id', 'inbox-document-file');
  expect(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  })).toEqual([]);
  expect(await inbox(page).locator('label[for="inbox-document-file"]').evaluate((label: HTMLLabelElement) => label.control?.id)).toBe('inbox-document-file');
  await input.setInputFiles({ name: 'local-choice.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF synthetic only') });
  await expect(inbox(page).getByRole('button', { name: 'Upload document', exact: true })).toBeEnabled();
  await capture(page, info, 'owned-document-selection');
  await select.selectOption(doc.id);
  await form.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('status').filter({ hasText: 'Answer acknowledged.' })).toBeVisible();
  expect(AnswerCommandSchema.parse(f.state.writes[0].body).answer).toEqual({ type: 'document', documentId: doc.id, version: 3, sha256: doc.sha256 });
});

test('submitted notifications are not questions', async ({ page }, info) => {
  fixtures.get(page)!.state.notifications = true;
  await page.goto('/sign-in');
  await main(page).getByRole('button', { name: /^Notification inbox:/ }).click();
  const item = inbox(page).getByRole('listitem').filter({ hasText: 'Submitted' });
  await expect(item).toBeVisible();
  await expect(item.getByRole('button', { name: 'Open question' })).toHaveCount(0);
  await capture(page, info, 'submitted-notification');
});

for (const kind of ['provider_unavailable', 'failed', 'needs_policy_decision'] as const) {
  test(`${kind} remains a distinct operational item`, async ({ page }, info) => {
    const f = fixtures.get(page)!;
    f.state.q = kind === 'needs_policy_decision' ? question(undefined, kind) : question({ ...baseField, type: 'intervention' }, kind);
    await open(page);
    await inbox(page).getByRole('button', { name: 'Open question' }).click();
    const name = kind === 'provider_unavailable' ? 'Provider unavailable' : kind === 'failed' ? 'Failed' : 'Policy decision';
    await expect(inbox(page).getByText(name, { exact: true })).toBeVisible();
    await expect(inbox(page).getByRole('button', { name: 'Focus paired browser' })).toHaveCount(0);
    if (kind !== 'needs_policy_decision') await expect(inbox(page).getByRole('button', { name: 'Save answer' })).toHaveCount(0);
    expect(f.state.writes).toHaveLength(0);
    await capture(page, info, kind);
  });
}

test('blank and decline appear only when both question and policy allow them', async ({ page }) => {
  const f = fixtures.get(page)!;
  f.state.q = question({ ...baseField, type: 'select', allowBlank: true, declineValue: 'decline',
    options: [{ value: 'school', label: 'School address' }, { value: 'decline', label: 'Decline' }],
    minSelections: 0, maxSelections: 1 });
  f.state.q.descriptor.required = false;
  f.state.q.canBlank = true; f.state.q.canDecline = true;
  await current(page);
  await inbox(page).getByRole('combobox', { name: 'Response', exact: true }).selectOption('decline');
  await inbox(page).getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect(inbox(page).getByRole('status').filter({ hasText: 'Answer acknowledged.' })).toBeVisible();
  expect(AnswerCommandSchema.parse(f.state.writes[0].body).answer).toEqual({ type: 'decline', value: 'decline' });
});

for (const path of ['/', '/?tab=engineering', '/talkie', '/profile', '/workers', '/applications/import']) {
  test(`header integration ${path}`, async ({ page }, info) => {
    await open(page, path);
    await capture(page, info, `header-${path.replace(/\W/g, '-')}`);
  });
}
