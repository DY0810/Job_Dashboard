import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DiscoveryControl } from '../../app/applications/import/control';
import { DiscoveryFixture, marks, ownerA, ownerB, runId, otherRunId } from './fixture';

let fixture: DiscoveryFixture;
let control: DiscoveryControl;
beforeEach(() => {
  fixture = new DiscoveryFixture();
  control = new DiscoveryControl(() => {});
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBe('error');
    const result = await fixture.handle(path, init.method ?? 'GET', new Headers(init.headers),
      init.body ? JSON.parse(String(init.body)) : null);
    return Response.json(result.json, { status: result.status });
  });
});
afterEach(() => { control.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function preview() {
  await control.refreshSession();
  await control.preview(marks);
}
async function select() {
  await preview();
  control.select(1, true);
  control.select(999999, true);
  control.confirmOwnership(true);
}

test('session refresh never enumerates storage or creates a preview; selection and ownership start empty', async () => {
  await control.refreshSession();
  expect(fixture.writes).toEqual([]);
  await control.preview(marks);
  expect(control.view.selected).toEqual([]);
  expect(control.view.ownership).toBe(false);
  await control.confirm();
  expect(fixture.writes).toHaveLength(1);
});

test('confirm keeps unknown IDs manual, verifies acknowledgement, and never deletes browser flags', async () => {
  await select();
  await control.confirm();
  expect(control.view.ack?.status).toBe('manual_reported');
  expect(control.view.ack?.unresolvedCount).toBe(1);
  expect(control.view.ack?.resolvedCount).toBe(1);
  expect(fixture.writes[1].owner).toBe(ownerA);
  expect(fixture.writes[1].body.confirmOwnership).toBe(true);
  expect(marks.getItem()).toBe('1');
});

test('lost confirm acknowledgement and same-owner reauth preserve exact request, selection and consent', async () => {
  await select();
  fixture.loseNext = true;
  await control.confirm();
  const pending = structuredClone(control.view.pending);
  fixture.owner = null;
  await control.refreshSession();
  expect(control.view.locked).toBe(true);
  expect(control.view.pending).toEqual(pending);
  fixture.owner = ownerA;
  await control.refreshSession();
  expect(control.view.selected).toEqual([1, 999999]);
  expect(control.view.ownership).toBe(true);
  await control.retry();
  expect(fixture.writes[1]).toEqual(fixture.writes[2]);
  expect(control.view.pending).toBeNull();
  expect(control.view.ack).not.toBeNull();
});

test('503 retains confirm; expiry releases it but retains row selection until explicitly renewed', async () => {
  await select();
  fixture.rejectConfirm = 503;
  await control.confirm();
  const pending = control.view.pending;
  expect(pending).not.toBeNull();
  fixture.rejectConfirm = 409;
  await control.retry();
  expect(fixture.writes[1].body).toEqual(fixture.writes[2].body);
  expect(control.view.pending).toBeNull();
  expect(control.view.expired).toBe(true);
  expect(control.view.selected).toEqual([1, 999999]);
  expect(control.view.error).not.toContain('unsafe-secret');
  await control.preview(marks);
  expect(fixture.writes[3].body.requestId).not.toBe(fixture.writes[0].body.requestId);
  expect(control.view.selected).toEqual([1, 999999]);
  expect(control.view.ownership).toBe(false);
});

test('a skewed local clock does not expire the backend preview', async () => {
  await select();
  expect(control.view.preview!.expiresAt).toBeLessThan(Date.now());
  await control.confirm();
  expect(control.view.ack).not.toBeNull();
});

test('principal change clears preview, selection, consent and pending before any write', async () => {
  await select();
  fixture.owner = ownerB;
  await control.confirm();
  expect(fixture.writes).toHaveLength(1);
  expect(control.view.preview).toBeNull();
  expect(control.view.selected).toEqual([]);
  expect(control.view.ownership).toBe(false);
  expect(control.view.pending).toBeNull();
  expect(control.view.locked).toBe(true);
});

test('principal change after write cannot publish an old-owner acknowledgement', async () => {
  await select();
  fixture.afterWrite = () => { fixture.owner = ownerB; };
  await control.confirm();
  expect(control.view.preview).toBeNull();
  expect(control.view.ack).toBeNull();
  expect(control.view.pending).toBeNull();
});

test('superseded late preview cannot repopulate a switched account', async () => {
  await control.refreshSession();
  let release!: () => void;
  fixture.afterWrite = () => new Promise<void>((resolve) => { release = resolve; });
  const request = control.preview(marks);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  fixture.owner = ownerB;
  await control.refreshSession();
  release();
  await request;
  expect(control.view.account?.ownerId).toBe(ownerB);
  expect(control.view.preview).toBeNull();
  expect(control.view.pending).toBeNull();
});

test('wrong-owner preview is discarded even if the session still reports the old owner', async () => {
  fixture.preview.ownerId = ownerB;
  await preview();
  expect(control.view.preview).toBeNull();
  expect(control.view.locked).toBe(true);
  expect(control.view.pending).toBeNull();
});

test('overflow and denied storage never write a partial preview', async () => {
  await control.refreshSession();
  await control.preview({ length: 1001, key: (i) => `workie-applied:${i + 1}`, getItem: () => '1' });
  expect(control.view.error).toContain('1,000');
  await control.preview({ length: 1, key() { throw new Error('unsafe-secret'); }, getItem: () => '1' });
  expect(control.view.error).toContain('Browser storage');
  expect(fixture.writes).toEqual([]);
});

test('discovery is selected-run only, preserves >601 backlog and distinguishes failed refresh from last scan', async () => {
  await control.refreshSession();
  control.selectRun(runId);
  expect(control.view.status).toBeNull();
  await control.refreshStatus();
  expect(control.view.status?.candidateCount).toBe(601);
  expect(control.view.status?.stagedCount).toBe(200);
  expect(Object.values(control.view.status!.counts).reduce((a, b) => a + b, 0)).toBe(691);
  fixture.failStatus = true;
  await control.refreshStatus();
  expect(control.view.status?.lastScanAt).toBe(1000);
  expect(control.view.statusStale).toBe(true);
  expect(control.view.error).not.toContain('unsafe-secret');
  control.selectRun(otherRunId);
  expect(control.view.status).toBeNull();
  fixture.failStatus = false;
  await control.refreshStatus();
  expect(control.view.status?.runId).toBe(otherRunId);
});

test('a forbidden session check is not a definitive rejection of an earlier uncertain confirm', async () => {
  await select();
  fixture.loseNext = true;
  await control.confirm();
  const pending = structuredClone(control.view.pending);
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => path === '/api/auth/applicant' ?
    Response.json({ error: 'unsafe-secret-error' }, { status: 403 }) : fetch(path, init));
  await control.refreshSession();
  expect(control.view.pending).toEqual(pending);
  expect(control.view.selected).toEqual([1, 999999]);
  expect(control.view.locked).toBe(true);
  vi.stubGlobal('fetch', fetch);
  await control.refreshSession();
  await control.retry();
  expect(fixture.writes[1]).toEqual(fixture.writes[2]);
});

test('status checks bind even the first response to the Workers panel owner', async () => {
  control.dispose();
  control = new DiscoveryControl(() => {}, ownerA);
  control.selectRun(runId);
  fixture.owner = ownerB;
  await control.refreshStatus();
  expect(control.view.runId).toBe('');
  expect(control.view.status).toBeNull();
  expect(control.view.locked).toBe(true);
});

test('lost preview response replays the same preview request after reauthentication', async () => {
  await control.refreshSession();
  fixture.loseNext = true;
  await control.preview(marks);
  const pending = structuredClone(control.view.pending);
  expect(pending?.kind).toBe('preview');
  fixture.owner = null;
  await control.refreshSession();
  fixture.owner = ownerA;
  await control.refreshSession();
  expect(control.view.pending).toEqual(pending);
  await control.retry();
  expect(fixture.writes[0]).toEqual(fixture.writes[1]);
  expect(control.view.preview).not.toBeNull();
});

test('an untagged mutation precondition rejection rechecks and clears the old principal', async () => {
  await select();
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path.endsWith('/confirm')) {
      fixture.owner = ownerB;
      return Response.json({ error: 'Applicant session changed. Unlock the current account.' }, { status: 403 });
    }
    return fetch(path, init);
  });
  await control.confirm();
  expect(control.view.pending).toBeNull();
  expect(control.view.preview).toBeNull();
  expect(control.view.selected).toEqual([]);
  expect(control.view.error).toContain('Account changed');
});

test('mismatched acknowledgement never becomes import success or releases the retry identity', async () => {
  await select();
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await fetch(path, init);
    return path.endsWith('/confirm') ? Response.json({ ...await response.json(), importedPostingIds: [1] }) : response;
  });
  await control.confirm();
  expect(control.view.ack).toBeNull();
  expect(control.view.pending?.kind).toBe('confirm');
});

test('changing selected run discards an in-flight previous-run response', async () => {
  await control.refreshSession();
  control.selectRun(runId);
  const fetch = globalThis.fetch;
  let release!: () => void;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    const response = await fetch(path, init);
    if (path.endsWith('/discovery')) await new Promise<void>((resolve) => { release = resolve; });
    return response;
  });
  const request = control.refreshStatus();
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  control.selectRun(otherRunId);
  release();
  await request;
  expect(control.view.runId).toBe(otherRunId);
  expect(control.view.status).toBeNull();
});
