import { afterEach, expect, it, vi } from 'vitest';
import { InboxControl, emptyEdit, pollingDelay } from '../../app/inbox/control';
import { answerCommand, eligibleDocuments } from '../../app/inbox/answer';
import { baseField, fixture, id, ownerB, question, storage } from './fixtures';

const controls: InboxControl[] = [];
afterEach(() => { controls.forEach((control) => control.dispose()); controls.length = 0; vi.unstubAllGlobals(); });
function setup(f = fixture(), disk = storage()) {
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const result = await f.respond(path, init.method, typeof init.body === 'string' ? JSON.parse(init.body) : undefined, new Headers(init.headers));
    return new Response(JSON.stringify(result.json), { status: result.status });
  });
  const control = new InboxControl(() => {}, disk);
  controls.push(control);
  return { control, ...f, disk };
}
async function ready(test: ReturnType<typeof setup>) {
  await test.control.refresh();
  await test.control.select(test.state.q);
  expect(test.control.view.locked).toBe(false);
}

it('keeps read and resolve separate, and retains known counts on a failed refresh', async () => {
  const t = setup(); await ready(t);
  await t.control.markRead(t.control.view.inbox!.items[0].eventId);
  expect(t.control.view.inbox).toMatchObject({ unread: 0, unresolved: 1 });
  expect(t.state.resumes).toBe(0);
  t.state.inboxError = true;
  await t.control.refresh();
  expect(t.control.view.inbox).toMatchObject({ unread: 0, unresolved: 1 });
  expect(t.control.view.error).toContain('unavailable');
});

it('retries the exact uncertain answer after reload and retains a newer edit without sending it', async () => {
  const t = setup(); await ready(t);
  t.control.edit({ ...emptyEdit(), input: 'original' });
  t.state.answerMode = 'lost';
  await t.control.answer(answerCommand(t.state.q, t.control.view.snapshot.drafts[t.state.q.id].desired, []));
  const original = structuredClone(t.state.writes[0]);
  t.control.edit({ ...emptyEdit(), input: 'newer' });
  const slot = () => Array.from({ length: t.disk.length }, (_, i) => t.disk.getItem(t.disk.key(i)!)).join('');
  await vi.waitFor(() => expect(slot()).toContain('ciphertext'));
  const persisted = t.control.view.snapshot;
  t.control.dispose();
  // Disposal performs the final encryption asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const reloaded = setup({ state: t.state, respond: t.respond }, t.disk);
  await reloaded.control.refresh();
  await reloaded.control.recover(0);
  expect(reloaded.control.view.snapshot).toEqual(persisted);
  expect(t.state.writes).toHaveLength(1);
  t.state.answerMode = 'ok';
  await reloaded.control.retry();
  expect(t.state.writes[1]).toEqual(original);
  expect(t.state.resumes).toBe(1);
  expect(t.state.writes).toHaveLength(2);
  expect(reloaded.control.view.snapshot.drafts[t.state.q.id]).toMatchObject({ desired: { input: 'newer' }, dirty: true });
  expect(reloaded.control.view.notice).toContain('newer edit');
});

it('same-owner reauthentication and key rotation preserve latest edits and exact pending request', async () => {
  const t = setup(); await ready(t);
  t.state.answerMode = 'offline';
  t.control.edit({ ...emptyEdit(), input: 'first' });
  await t.control.answer(answerCommand(t.state.q, t.control.view.snapshot.drafts[t.state.q.id].desired, []));
  t.control.edit({ ...emptyEdit(), input: 'last' });
  const pending = structuredClone(t.control.view.snapshot.pending);
  t.state.auth = 401; await t.control.refresh();
  expect(t.control.view.locked).toBe(true);
  t.state.auth = 200; t.state.keyVersion = '2'; await t.control.refresh();
  expect(t.control.view.locked).toBe(false);
  expect(t.control.view.snapshot.pending).toEqual(pending);
  expect(t.control.view.snapshot.drafts[t.state.q.id].desired.input).toBe('last');
  expect(t.state.writes).toHaveLength(1);
});

it('account changes abort owner operations and remove all plaintext, including pending drafts', async () => {
  const t = setup(); await ready(t);
  t.control.edit({ ...emptyEdit(), input: 'private A' });
  const signal = t.control.signal;
  t.state.owner = ownerB; await t.control.refresh();
  expect(signal.aborted).toBe(true);
  expect(t.control.view.snapshot.drafts).toEqual({});
  expect(t.control.view.selected).toBeNull();
  expect(JSON.stringify(t.control.view)).not.toContain('private A');
  expect(t.control.view.inbox?.items).toEqual([]);
});

it('changed schema/scope fences drafts and never silently reuses their previous scope', async () => {
  const q = question(); q.allowedReuse = ['application', 'employer'];
  const t = setup(fixture(q)); await ready(t);
  t.control.edit({ ...emptyEdit(), input: 'private', reuse: 'employer' });
  t.state.q = { ...q, revision: 2, expectedScopeHash: 'b'.repeat(64), allowedReuse: ['application'] };
  await t.control.refresh();
  await t.control.answer({ ...answerCommand(q, { ...emptyEdit(), input: 'private', reuse: 'employer' }, []), expectedRevision: 2 });
  expect(t.state.writes).toHaveLength(0);
  expect(t.control.view.error).toContain('changed');
  t.control.acceptCurrent();
  expect(t.control.view.snapshot.drafts[q.id].desired).toMatchObject({ input: 'private', reuse: 'application' });
});

it('focus is a command acknowledgement, not completion or a mark-read', async () => {
  const t = setup(fixture(question({ ...baseField, type: 'intervention' }, 'needs_verification'))); await ready(t);
  await t.control.focus();
  expect(t.control.view.selected?.focus?.status).toBe('pending');
  expect(t.control.view.inbox).toMatchObject({ unread: 1, unresolved: 1 });
  expect(t.state.resumes).toBe(0);
  expect(t.state.writes).toHaveLength(1);
});

it('a late answer response after a principal switch cannot repopulate or resume the old UI', async () => {
  const t = setup(); await ready(t);
  let release!: () => void;
  t.state.beforeAnswer = () => new Promise<void>((resolve) => { release = resolve; });
  t.control.edit({ ...emptyEdit(), input: 'private pending' });
  const work = t.control.answer(answerCommand(t.state.q, t.control.view.snapshot.drafts[t.state.q.id].desired, []));
  await vi.waitFor(() => expect(t.state.writes).toHaveLength(1));
  t.state.owner = ownerB;
  t.control.suspend();
  await t.control.refresh();
  release();
  await work;
  expect(t.control.view.ownerId).toBe(ownerB);
  expect(t.control.view.snapshot.pending).toBeNull();
  expect(t.control.view.snapshot.drafts).toEqual({});
  expect(t.control.view.notice).not.toContain('acknowledged');
});

it('a rejected stale answer refreshes truth but leaves latest input for explicit review', async () => {
  const t = setup(); await ready(t);
  t.control.edit({ ...emptyEdit(), input: 'my answer' });
  const command = answerCommand(t.state.q, t.control.view.snapshot.drafts[t.state.q.id].desired, []);
  t.state.q = { ...t.state.q, revision: 2, expectedPolicyRevision: 2 };
  t.state.answerMode = 'conflict';
  await t.control.answer(command);
  expect(t.control.view.snapshot.pending).toBeNull();
  expect(t.control.view.snapshot.drafts[t.state.q.id].desired.input).toBe('my answer');
  expect(t.control.view.selected?.revision).toBe(2);
  expect(t.control.view.error).toContain('changed');
  expect(t.state.writes).toHaveLength(1);
});

it('uses protocol precision/units/options and permits only eligible immutable documents', () => {
  const numeric = question({ ...baseField, type: 'number', min: 1, max: 40, units: 'hours/week', precision: 1, integer: false });
  expect(answerCommand(numeric, { ...emptyEdit(), input: '12.5' }, []).answer).toEqual({ type: 'number', value: 12.5, units: 'hours/week', precision: 1 });
  expect(() => answerCommand(numeric, { ...emptyEdit(), input: '12.55' }, [])).toThrow();
  expect(() => answerCommand(numeric, { ...emptyEdit(), input: '' }, [])).toThrow();
  const date = question({ ...baseField, type: 'date', precision: 'month', min: '2026-01', max: '2027-12' });
  expect(answerCommand(date, { ...emptyEdit(), input: '2026-09' }, []).answer).toMatchObject({ precision: 'month' });
  expect(() => answerCommand(date, { ...emptyEdit(), input: '2026-09-21' }, [])).toThrow();
  const docQ = question({ ...baseField, type: 'document', documentKinds: ['transcript'], mimeTypes: ['application/pdf'], maxBytes: 100 }, 'needs_document');
  const doc = { id: id(), version: 3, sha256: 'd'.repeat(64), name: 'synthetic.pdf', state: 'available', kind: 'transcript', mime: 'application/pdf', size: 50 };
  expect(eligibleDocuments(docQ, [doc, { ...doc, id: id(), state: 'quarantined' }, { ...doc, id: id(), kind: 'resume_master' }])).toEqual([doc]);
  expect(answerCommand(docQ, { ...emptyEdit(), input: doc.id }, [doc]).answer).toMatchObject({ documentId: doc.id, version: 3, sha256: doc.sha256 });
  expect(pollingDelay(100)).toBe(120_000);
});
