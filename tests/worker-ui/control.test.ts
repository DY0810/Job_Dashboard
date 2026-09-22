import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { WorkerControl, applicationActions, pairingStatus, workerStatus } from '../../app/workers/control';
import { APPLICATION_STATES } from '../../lib/applications/state';
import { HEARTBEAT_MS, PAIRING_TTL_MS } from '../../lib/applications/worker-protocol';
import { WorkerFixture, ownerA, ownerB, syntheticGrant, workerId } from './fixture';

let fixture: WorkerFixture;
let control: WorkerControl;
beforeEach(() => {
  fixture = new WorkerFixture();
  control = new WorkerControl(() => {});
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    expect(init.cache).toBe('no-store');
    expect(init.credentials).toBe('same-origin');
    expect(init.redirect).toBe('error');
    expect(path).not.toContain('?');
    expect(path).not.toContain(syntheticGrant);
    expect(init.body ?? '').not.toContain(syntheticGrant);
    const response = await fixture.handle(path, init.method ?? 'GET', new Headers(init.headers),
      init.body ? JSON.parse(String(init.body)) : null);
    return Response.json(response.json, { status: response.status });
  });
});
afterEach(() => { control.dispose(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

test('hash-only lost grant acknowledgement retains the request on refresh and becomes an explicit conflict on replay', async () => {
  await control.refresh();
  fixture.loseNext = true;
  await control.createPairing('Synthetic laptop');
  const pending = structuredClone(control.view.pending);
  expect(control.view.grant).toBeNull();
  await control.refresh();
  expect(control.view.pending).toEqual(pending);
  await control.retry();
  expect(control.view.error).toContain('secret is unavailable');
  expect(control.view.pending).toBeNull();
  expect(fixture.pairings).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
});

test('acknowledged grant survives head failure without another create and expires against server time', async () => {
  await control.refresh();
  fixture.afterWrite = async () => { fixture.failHead = true; };
  await control.createPairing('Synthetic laptop');
  expect(!!control.view.grant).toBe(true);
  expect(control.view.pending?.ack).toBeDefined();
  fixture.failHead = false; fixture.afterWrite = undefined;
  await control.refresh();
  await control.retry();
  expect(fixture.writes).toHaveLength(1);
  fixture.now += PAIRING_TTL_MS;
  await control.refresh();
  expect(control.view.grant).toBeNull();
  expect(pairingStatus(fixture.pairings[0], fixture.now)).toBe('Expired');
});

test('principal switch clears plaintext, pending intent and late responses', async () => {
  await control.refresh();
  await control.createPairing('Synthetic laptop');
  expect(!!control.view.grant).toBe(true);
  let release!: () => void;
  fixture.afterWrite = () => new Promise<void>((resolve) => { release = resolve; });
  const action = control.createRun(workerId);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  fixture.switchOwner();
  await control.refresh();
  release();
  await action;
  expect(control.view.account?.ownerId).toBe(ownerB);
  expect(control.view.grant).toBeNull();
  expect(control.view.pending).toBeNull();
  expect(control.view.runs?.runs).toEqual([]);
});

test.each(['/api/workers', '/api/application-runs'])('wrong-owner %s clears grants and pending intent before any later head failure', async (wrongPath) => {
  await control.refresh();
  await control.createPairing('Owner A only');
  fixture.loseNext = true;
  await control.createRun(workerId);
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path === wrongPath) return Response.json(path === '/api/workers' ?
      { ownerId: ownerB, serverTime: fixture.now, workers: [], pairings: [] } : { ownerId: ownerB, runs: [], applications: [] });
    if (path === '/api/auto-apply/policies') return Response.json({ code: 'UNAVAILABLE' }, { status: 503 });
    return fetch(path, init);
  });
  await control.refresh(true);
  expect(control.view.locked).toBe(true);
  expect(control.view.account).toBeNull();
  expect(control.view.workers).toBeNull();
  expect(control.view.runs).toBeNull();
  expect(control.view.pending).toBeNull();
  expect(control.view.grant).toBeNull();
  expect(control.view.error).toContain('Account changed');
});

test('an untagged policy precondition rejection rechecks ownership and clears the previous applicant', async () => {
  await control.refresh();
  await control.createPairing('Owner A only');
  const fetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    if (path === '/api/auto-apply/policies') {
      fixture.switchOwner();
      return Response.json({ error: 'Applicant session changed.' }, { status: 403 });
    }
    return fetch(path, init);
  });
  await control.refresh(true);
  expect(control.view.account).toBeNull();
  expect(control.view.grant).toBeNull();
  expect(control.view.locked).toBe(true);
  expect(control.view.error).toContain('Account changed');
});

test('same-owner reauthentication preserves the grant and exact pending command without automatic replay', async () => {
  await control.refresh();
  await control.createPairing('Owner A only');
  const grant = control.view.grant;
  fixture.loseNext = true;
  await control.createRun(workerId);
  const pending = structuredClone(control.view.pending);
  control.suspend();
  fixture.authStatus = 401;
  await control.refresh();
  await control.retry();
  expect(control.view.locked).toBe(true);
  expect(control.view.pending).toEqual(pending);
  expect(control.view.grant).toEqual(grant);
  expect(fixture.writes).toHaveLength(2);
  fixture.authStatus = 200;
  await control.refresh();
  expect(control.view.account?.ownerId).toBe(ownerA);
  expect(control.view.pending).toEqual(pending);
  expect(control.view.grant).toEqual(grant);
  expect(fixture.writes).toHaveLength(2);
  await control.retry();
  expect(fixture.writes[1].body).toEqual(fixture.writes[2].body);
  expect(control.view.pending).toBeNull();
  expect(fixture.runs).toHaveLength(1);
});

test('copy rechecks the owner and cannot write an old owner grant to the clipboard', async () => {
  const writeText = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await control.refresh();
  await control.createPairing('Synthetic laptop');
  expect(writeText).not.toHaveBeenCalled();
  fixture.switchOwner();
  await control.copySecret();
  expect(writeText).not.toHaveBeenCalled();
  expect(control.view.grant).toBeNull();
  expect(control.view.locked).toBe(true);
});

test('grant copy is explicit; expiry, dismissal and disposal remove the transient secret', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await control.refresh();
  await control.createPairing('Synthetic laptop');
  expect(writeText).not.toHaveBeenCalled();
  await control.copySecret();
  expect(writeText).toHaveBeenCalledExactlyOnceWith(syntheticGrant);
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + PAIRING_TTL_MS + 1);
  control.tick();
  await control.copySecret();
  expect(control.view.grant).toBeNull();
  expect(writeText).toHaveBeenCalledTimes(1);
  await control.createPairing('Second explicit approval');
  control.clearSecret();
  await control.refresh();
  expect(control.view.grant).toBeNull();
  await control.createPairing('Third explicit approval');
  control.dispose();
  expect(control.view.grant).toBeNull();
  expect(control.view.account).toBeNull();
});

test('revocation CAS conflicts refresh current heads and a reviewed action uses a new request ID', async () => {
  fixture.addRun();
  await control.refresh();
  const stale = control.view.workers!.workers[0];
  fixture.workers[0].revision++;
  await control.revoke('worker', stale);
  expect(control.view.error).toContain('State changed');
  expect(control.view.workers!.workers[0].revision).toBe(2);
  expect(control.view.pending).toBeNull();
  await control.revoke('worker', control.view.workers!.workers[0]);
  expect(workerStatus(control.view.workers!.workers[0], fixture.now)).toBe('Revoked');
  expect(control.view.runs!.runs[0].state).toBe('paused');
  expect(fixture.writes[0].body!.requestId).not.toBe(fixture.writes[1].body!.requestId);
});

test('historical run create acknowledgement never replaces a newer stopped head', async () => {
  await control.refresh();
  fixture.loseNext = true;
  await control.createRun(workerId);
  fixture.runs[0].state = 'stopped'; fixture.runs[0].revision++;
  await control.refresh();
  await control.retry();
  expect(control.view.runs!.runs[0].state).toBe('stopped');
  expect(control.view.notice).toContain('Earlier request acknowledged');
  expect(fixture.runs).toHaveLength(1);
  expect(fixture.writes[0].body).toEqual(fixture.writes[1].body);
});

test('emergency stop reads a fresh head, fences pending resume and preserves unknown submission', async () => {
  fixture.addRun('paused');
  fixture.addApplication('submitting', 'submit_started');
  await control.refresh();
  const stale = control.view.runs!.runs[0];
  fixture.loseNext = true;
  await control.commandRun(stale, 'resume');
  await control.commandRun(stale, 'emergency-stop');
  expect(control.view.runs!.runs[0].state).toBe('stopped');
  expect(control.view.runs!.applications[0].state).toBe('submission_unknown');
  expect(control.view.pending).toBeNull();
  expect(fixture.writes[1].body!.expectedRevision).toBe(2);
});

test.each(['same', 'different'])('delayed-before-commit resume then emergency stop on %s run retains only unfenced intent', async (target) => {
  const a = fixture.addRun('paused');
  const b = target === 'same' ? a : fixture.addRun();
  const submission = fixture.addApplication('submitting', 'submit_started', b.id);
  await control.refresh();
  let release!: () => void;
  fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
  const delayed = control.commandRun(control.view.runs!.runs[0], 'resume');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const pending = control.view.pending;
  const body = structuredClone(pending!.body);
  expect(a.state).toBe('paused');
  fixture.beforeWrite = undefined;
  await control.commandRun(b, 'emergency-stop');
  expect(b.state).toBe('stopped');
  expect(submission.state).toBe('submission_unknown');
  release();
  await delayed;
  expect(a.state).toBe(target === 'same' ? 'stopped' : 'running');
  if (target === 'same') {
    expect(control.view.pending).toBeNull();
    await control.retry();
    expect(fixture.writes).toHaveLength(2);
  } else {
    expect(control.view.pending).toBe(pending);
    expect(control.view.pending!.body).toEqual(body);
    await control.createRun(workerId);
    expect(fixture.writes).toHaveLength(2);
    await control.refresh();
    expect(control.view.pending).toBe(pending);
    expect(control.view.runs!.runs[0].state).toBe('running');
    await control.retry();
    expect(fixture.writes).toHaveLength(3);
    expect(fixture.writes[2].body).toEqual(body);
    expect(control.view.pending).toBeNull();
  }
});

test.each(['same application', 'sibling in same run', 'different run'])(
  'delayed-before-commit application command then emergency stop on %s does not infer a sibling fence', async (target) => {
    const run = fixture.addRun();
    const a = fixture.addApplication(target === 'same application' ? 'submitting' : 'queued');
    const b = target === 'same application' ? a : fixture.addApplication('submitting', 'submit_started',
      target === 'different run' ? fixture.addRun().id : run.id);
    await control.refresh();
    let release!: () => void;
    fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
    const delayed = control.commandApplication(a, target === 'same application' ? 'emergency-stop' : 'skip');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const pending = control.view.pending;
    fixture.beforeWrite = undefined;
    await control.commandApplication(b, 'emergency-stop');
    expect(a.state).toBe(target === 'same application' ? 'submission_unknown' : 'queued');
    release();
    await delayed;
    if (target === 'same application') {
      expect(a.state).toBe('submission_unknown');
      expect(control.view.pending).toBeNull();
    } else {
      expect(a.state).toBe('skipped');
      expect(b.state).toBe('submission_unknown');
      expect(control.view.pending).toBe(pending);
      await control.retry();
      expect(fixture.writes).toHaveLength(3);
      expect(fixture.writes[2].body).toEqual(fixture.writes[0].body);
      expect(control.view.runs!.applications.find((app) => app.id === a.id)?.state).toBe('skipped');
      expect(control.view.pending).toBeNull();
    }
  });

test('an application emergency stop does not fence a delayed resume of its own run', async () => {
  const run = fixture.addRun('paused');
  const app = fixture.addApplication('submitting', 'submit_started');
  await control.refresh();
  let release!: () => void;
  fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
  const delayed = control.commandRun(run, 'resume');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const pending = control.view.pending;
  fixture.beforeWrite = undefined;
  await control.commandApplication(app, 'emergency-stop');
  release();
  await delayed;
  expect(run.state).toBe('running');
  expect(app.state).toBe('submission_unknown');
  expect(control.view.pending).toBe(pending);
  await control.retry();
  expect(fixture.writes[2].body).toEqual(fixture.writes[0].body);
  expect(control.view.pending).toBeNull();
});

test.each(['same owner', 'new principal'])('multiple interrupted commands survive only %s refresh', async (owner) => {
  const a = fixture.addRun('paused'), b = fixture.addRun(), c = fixture.addRun();
  await control.refresh();
  await control.createPairing('Owner A only');
  let release!: () => void;
  fixture.beforeWrite = () => new Promise<void>((resolve) => { release = resolve; });
  const delayed = control.commandRun(a, 'resume');
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const pendingA = control.view.pending;
  fixture.beforeWrite = undefined;
  fixture.loseNext = true;
  await control.commandRun(b, 'emergency-stop');
  const pendingB = control.view.pending;
  expect(pendingB!.id).toBe(b.id);
  if (owner === 'new principal') fixture.switchOwner();
  else fixture.authStatus = 401;
  control.suspend();
  await control.refresh();
  fixture.authStatus = 200;
  await control.refresh();
  release();
  await delayed;
  if (owner === 'new principal') {
    expect(control.view.account?.ownerId).toBe(ownerB);
    expect(control.view.grant).toBeNull();
    expect(control.view.pending).toBeNull();
    const next = fixture.addRun();
    await control.refresh();
    await control.commandRun(next, 'emergency-stop');
    await control.retry();
    expect(control.view.pending).toBeNull();
    expect(fixture.writes).toHaveLength(4);
    expect(fixture.writes[3].owner).toBe(ownerB);
  } else {
    expect(control.view.pending).toBe(pendingB);
    expect(control.view.grant).not.toBeNull();
    expect(fixture.writes).toHaveLength(3);
    await control.commandRun(c, 'emergency-stop');
    expect(control.view.pending).toBe(pendingB);
    await control.retry();
    expect(fixture.writes[4].body).toEqual(fixture.writes[2].body);
    expect(control.view.pending).toBe(pendingA);
    await control.retry();
    expect(fixture.writes[5].body).toEqual(fixture.writes[1].body);
    expect(control.view.pending).toBeNull();
  }
});

test('an acknowledged interrupted command reconciles without another write after an unrelated stop', async () => {
  const a = fixture.addRun('paused'), b = fixture.addRun();
  await control.refresh();
  fixture.afterWrite = async () => { fixture.failHead = true; };
  await control.commandRun(a, 'resume');
  const pending = control.view.pending;
  expect(pending?.ack).toBeDefined();
  fixture.afterWrite = undefined; fixture.failHead = false;
  await control.commandRun(b, 'emergency-stop');
  expect(control.view.pending).toBe(pending);
  await control.retry();
  expect(fixture.writes).toHaveLength(2);
  expect(control.view.pending).toBeNull();
});

test('a rejected emergency stop restores the superseded request without discarding or replaying it', async () => {
  const a = fixture.addRun('paused'), b = fixture.addRun();
  await control.refresh();
  fixture.loseNext = true;
  await control.commandRun(a, 'resume');
  const pending = control.view.pending;
  fixture.beforeWrite = async () => { b.revision++; };
  await control.commandRun(b, 'emergency-stop');
  expect(control.view.error).toContain('State changed');
  expect(control.view.pending).toBe(pending);
  expect(fixture.writes).toHaveLength(2);
  fixture.beforeWrite = undefined;
  await control.retry();
  expect(fixture.writes[2].body).toEqual(fixture.writes[0].body);
  expect(control.view.pending).toBeNull();
});

test.each(['/api/workers', '/api/application-runs', '/api/auto-apply/policies', '/api/auth/applicant'])(
  'time spent awaiting %s cannot extend grant expiry or heartbeat freshness at publication', async (delayedPath) => {
    let monotonic = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await control.refresh();
    await control.createPairing('Synthetic laptop');
    expect(control.view.grant).not.toBeNull();
    const sampledServerTime = fixture.now;
    const fetch = globalThis.fetch;
    let workersRead = false;
    let release!: () => void;
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const response = await fetch(path, init);
      if (path === '/api/workers') workersRead = true;
      if (workersRead && path === delayedPath) await new Promise<void>((resolve) => { release = resolve; });
      return response;
    });
    const refresh = control.refresh();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    monotonic += PAIRING_TTL_MS + 1;
    fixture.now += PAIRING_TTL_MS + 1;
    release();
    await refresh;
    expect(control.view.now).toBe(sampledServerTime + PAIRING_TTL_MS + 1);
    expect(control.view.grant).toBeNull();
    expect(workerStatus(control.view.workers!.workers[0], control.view.now)).toBe('Offline');
    await control.copySecret();
    expect(writeText).not.toHaveBeenCalled();
    monotonic += 1000;
    control.tick();
    expect(control.view.now).toBe(sampledServerTime + PAIRING_TTL_MS + 1001);
  });

test.each(['before copy', 'during owner check'])('copy samples elapsed time %s without waiting for a UI tick', async (delay) => {
  let monotonic = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
  const writeText = vi.fn();
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  await control.refresh();
  await control.createPairing('Synthetic laptop');
  if (delay === 'before copy') monotonic += PAIRING_TTL_MS;
  else {
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
      const response = await fetch(path, init);
      if (path === '/api/auth/applicant') monotonic += PAIRING_TTL_MS;
      return response;
    });
  }
  await control.copySecret();
  expect(writeText).not.toHaveBeenCalled();
  expect(control.view.grant).toBeNull();
});

test('application action matrix preserves unknown and terminal states; retry requires safe failure and checkpoint', () => {
  const run = fixture.addRun();
  for (const state of APPLICATION_STATES) {
    const app = fixture.addApplication(state);
    const actions = applicationActions(app, run);
    if (['submitted', 'failed', 'skipped', 'cancelled'].includes(state)) expect(actions).toEqual([]);
    else if (['submitting', 'submission_unknown'].includes(state)) expect(actions).toEqual(['emergency-stop']);
    else expect(actions).toEqual(['skip', 'cancel', ...(['provider_unavailable', 'retryable_failure'].includes(state) ? ['retry-safe'] : [])]);
    expect(applicationActions({ ...app, checkpoint: null }, run)).not.toContain('retry-safe');
    expect(applicationActions(app, { ...run, state: 'stopped' })).not.toContain('retry-safe');
  }
});

test('skip and cancel persist while the hidden safe-retry cap remains server authoritative', async () => {
  fixture.addRun();
  const skipped = fixture.addApplication('needs_document');
  const cancelled = fixture.addApplication('queued');
  const retryable = fixture.addApplication('retryable_failure', 'temporary_failure');
  await control.refresh();
  await control.commandApplication(skipped, 'skip');
  await control.commandApplication(cancelled, 'cancel');
  for (let attempt = 0; attempt < 3; attempt++) {
    await control.commandApplication(retryable, 'retry-safe');
    expect(retryable.state).toBe('screening');
    retryable.state = 'retryable_failure'; retryable.reasonCode = 'temporary_failure'; retryable.revision++;
    await control.refresh();
  }
  await control.commandApplication(retryable, 'retry-safe');
  expect(control.view.error).toContain('State changed');
  expect(control.view.pending).toBeNull();
  expect(control.view.runs!.applications.map((app) => app.state)).toEqual(['skipped', 'cancelled', 'retryable_failure']);
  await control.refresh();
  expect(control.view.runs!.applications[2].reasonCode).toBe('temporary_failure');
});

test('an empty durable run is allowed with execution unavailable but disabled policy prevents creation', async () => {
  await control.refresh();
  expect(control.view.policy?.runnerAvailable).toBe(false);
  await control.createRun(workerId);
  expect(control.view.runs!.runs).toHaveLength(1);
  expect(control.view.runs!.applications).toEqual([]);
  fixture.policy.enabled = false;
  await control.refresh();
  await control.createRun(workerId);
  expect(fixture.writes).toHaveLength(1);
});

test('offline and malformed/configuration/auth responses fail closed without invented readiness', async () => {
  await control.refresh();
  expect(workerStatus(fixture.workers[0], fixture.now + HEARTBEAT_MS * 3)).toBe('Offline');
  expect(control.view.policy?.runnerAvailable).toBe(false);
  fixture.addRun(); fixture.invalidState = true;
  await control.refresh();
  expect(control.view.locked).toBe(true);
  expect(control.view.error).toContain('Incompatible worker response');
  fixture.invalidState = false; fixture.authStatus = 503;
  await control.refresh();
  expect(control.view.error).toContain('configuration');
  fixture.authStatus = 401;
  await control.refresh();
  expect(control.view.error).toContain('Unlock Workie');
  await control.createRun(workerId);
  expect(fixture.writes).toHaveLength(0);
});
