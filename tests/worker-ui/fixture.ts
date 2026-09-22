import assert from 'node:assert/strict';
import { z } from 'zod';
import { createEmptyPolicy, PolicySchema } from '../../lib/applications/policy';
import { InboxPageSchema } from '../../lib/applications/question-protocol';
import { isTerminalState } from '../../lib/applications/state';
import {
  ApplicationCommandSchema, ApplicationSummarySchema, PairingCreateSchema, PairingGrantSchema,
  PAIRING_TTL_MS, RevisionCommandSchema, RevocationSchema, RunCommandSchema, RunCreateSchema,
  RunListSchema, RunSchema, WorkerListSchema, WorkerSummarySchema,
  type ApplicationSummary, type PairingSummary, type Run, type WorkerSummary,
} from '../../lib/applications/worker-protocol';

export const ownerA = 'synthetic-owner-a', ownerB = 'synthetic-owner-b';
export const workerId = '11111111-1111-4111-8111-111111111111';
export const runId = '22222222-2222-4222-8222-222222222222';
export const syntheticGrant = 's'.repeat(43);
type Reply = { status: number; json: unknown };
type Request = { path: string; method: string; owner: string | null; body: Record<string, unknown> | null };

export class WorkerFixture {
  owner = ownerA;
  authStatus = 200;
  now = Date.now();
  workers: WorkerSummary[] = [WorkerSummarySchema.parse({
    id: workerId, label: 'Synthetic laptop', revision: 1, workerVersion: '0.1.0', capabilities: ['control-v1'],
    createdAt: this.now - 60_000, lastSeenAt: this.now, revokedAt: null, online: true,
  })];
  pairings: PairingSummary[] = [];
  runs: Run[] = [];
  applications: ApplicationSummary[] = [];
  policy = {
    revision: 2, policy: PolicySchema.parse({ ...createEmptyPolicy(), actions: ['read_jobs'],
      destinations: ['employer.example.test'], countries: ['US'] }),
    enabled: true, policyVersion: 1, policyHash: 'a'.repeat(64), acceptedPolicyVersion: 1,
    acceptedPolicyHash: 'a'.repeat(64), acceptedAt: '2026-09-20T12:00:00.000Z', runnerAvailable: false,
  };
  requests: Request[] = [];
  loseNext = false;
  failHead = false;
  invalidState = false;
  beforeWrite?: () => Promise<void>;
  afterWrite?: () => Promise<void>;
  private acks = new Map<string, { input: string; reply: Reply }>();
  private retries = new Map<string, number>();

  addRun(state: Run['state'] = 'running') {
    const run = RunSchema.parse({ id: this.runs.length ? crypto.randomUUID() : runId, workerId, revision: 1, state, createdAt: this.now });
    this.runs.push(run);
    return run;
  }
  addApplication(state: ApplicationSummary['state'], reasonCode: string | null = null, applicationRunId = runId) {
    const app = ApplicationSummarySchema.parse({ id: crypto.randomUUID(), runId: applicationRunId, workerId, ats: 'synthetic',
      tenant: 'fixture-employer', requisition: `role-${this.applications.length + 1}`, revision: 1, state, reasonCode,
      checkpoint: { stage: 'screening', sequence: 1 } });
    this.applications.push(app);
    return app;
  }
  switchOwner() {
    this.owner = ownerB; this.workers = []; this.pairings = []; this.runs = []; this.applications = [];
  }
  async handle(path: string, method: string, headers: Headers, body: Record<string, unknown> | null): Promise<Reply> {
    const request = { path, method, owner: headers.get('x-workie-applicant'), body };
    this.requests.push(request);
    const reply = <T>(schema: z.ZodType<T>, value: unknown): Reply => ({ status: 200, json: schema.parse(value) });
    const error = (status: number, code: string): Reply => ({ status, json: { error: 'Synthetic rejection.', code } });
    if (path === '/api/auth/applicant') return this.authStatus === 200 ?
      { status: 200, json: { ownerId: this.owner, name: 'Synthetic', email: `${this.owner}@example.test` } } :
      error(this.authStatus, this.authStatus === 401 ? 'AUTH_REQUIRED' : 'UNAVAILABLE');
    if (path === '/api/auth/applicants') return { status: 200, json: { applicants: [
      { ownerId: this.owner, name: 'Synthetic', email: `${this.owner}@example.test`, active: true },
    ] } };
    assert.notEqual(request.owner, null, 'Every private worker/policy request must carry the applicant precondition');
    if (request.owner !== this.owner) return error(403, 'PRINCIPAL_CHANGED');
    if (this.authStatus !== 200) return error(this.authStatus, 'AUTH_REQUIRED');
    if (method === 'GET') {
      if (path === '/api/profile/draft-key') return { status: 200, json: {
        ownerId: this.owner, keyVersion: '1', key: btoa('s'.repeat(32)),
      } };
      if (path === '/api/inbox') return reply(InboxPageSchema, {
        ownerId: this.owner, unread: 0, unresolved: 0, waitingApplications: 0,
        serverTime: this.now, items: [], nextCursor: null,
      });
      if (this.failHead) return error(503, 'UNAVAILABLE');
      if (path === '/api/workers') return reply(WorkerListSchema, {
        ownerId: this.owner, serverTime: this.now, workers: this.workers, pairings: this.pairings,
      });
      if (path === '/api/application-runs') {
        const result = reply(RunListSchema, { ownerId: this.owner, runs: this.runs, applications: this.applications });
        return this.invalidState ? { status: 200, json: { ownerId: this.owner,
          runs: [{ ...this.runs[0], state: 'future-unknown-state' }], applications: this.applications } } : result;
      }
      if (path === '/api/auto-apply/policies') return { status: 200, json: structuredClone(this.policy) };
      throw new Error(`Unexpected synthetic GET: ${path}`);
    }
    assert.equal(headers.get('content-type'), 'application/json');
    assert.ok(body);
    const schema = path === '/api/workers/pairings' ? PairingCreateSchema :
      method === 'DELETE' ? RevisionCommandSchema : path === '/api/application-runs' ? RunCreateSchema :
        path.includes('/applications/') ? ApplicationCommandSchema : RunCommandSchema;
    schema.parse(body);
    const input = JSON.stringify([this.owner, path, method, body]);
    const key = `${this.owner}:${body.requestId}`;
    const previous = this.acks.get(key);
    if (previous) return previous.input !== input ? error(409, 'CONFLICT') :
      path === '/api/workers/pairings' ? error(409, 'GRANT_UNAVAILABLE') : structuredClone(previous.reply);
    await this.beforeWrite?.();
    if (request.owner !== this.owner) return error(403, 'PRINCIPAL_CHANGED');
    let result: Reply;
    if (path === '/api/workers/pairings') {
      const pairingId = crypto.randomUUID();
      this.pairings.push({ id: pairingId, label: String(body.label), revision: 1, expiresAt: this.now + PAIRING_TTL_MS, consumedAt: null, revokedAt: null });
      result = reply(PairingGrantSchema, { pairingId, ownerId: this.owner, grant: syntheticGrant, revision: 1, expiresAt: this.now + PAIRING_TTL_MS });
    } else if (method === 'DELETE') {
      const row = (path.includes('/pairings/') ? this.pairings : this.workers).find((row) => path.endsWith(row.id));
      if (!row) return error(404, 'NOT_FOUND');
      if (row.revision !== body.expectedRevision) return error(409, 'CONFLICT');
      if (row.revokedAt === null) { row.revision++; row.revokedAt = this.now; }
      if ('online' in row) {
        row.online = false;
        for (const run of this.runs.filter((run) => run.workerId === row.id && run.state === 'running')) { run.state = 'paused'; run.revision++; }
      }
      result = reply(RevocationSchema, { id: row.id, revision: row.revision, revokedAt: row.revokedAt });
    } else if (path === '/api/application-runs') {
      if (!this.policy.enabled) return error(403, 'FORBIDDEN');
      const worker = this.workers.find((row) => row.id === body.workerId && row.revokedAt === null);
      if (!worker) return error(403, 'FORBIDDEN');
      const run = RunSchema.parse({ id: crypto.randomUUID(), workerId: worker.id, revision: 1, state: 'running', createdAt: this.now });
      this.runs.push(run); result = reply(RunSchema, run);
    } else if (path.includes('/applications/')) {
      const app = this.applications.find((row) => path === `/api/application-runs/${row.runId}/applications/${row.id}/actions`);
      if (!app) return error(404, 'NOT_FOUND');
      if (app.revision !== body.expectedRevision || isTerminalState(app.state)) return error(409, 'CONFLICT');
      const ambiguous = ['submitting', 'submission_unknown'].includes(app.state);
      if (ambiguous && body.action !== 'emergency-stop') return error(409, 'CONFLICT');
      if (body.action === 'retry-safe') {
        const retries = this.retries.get(app.id) ?? 0;
        const run = this.runs.find((run) => run.id === app.runId);
        if (!['provider_unavailable', 'retryable_failure'].includes(app.state) || !app.checkpoint ||
            !run || run.state === 'stopped' || retries >= 3) return error(409, 'CONFLICT');
        this.retries.set(app.id, retries + 1);
        app.state = app.checkpoint.stage;
      } else app.state = ambiguous ? 'submission_unknown' : body.action === 'skip' ? 'skipped' : 'cancelled';
      app.reasonCode = String(body.action); app.revision++;
      result = reply(ApplicationSummarySchema, app);
    } else {
      const run = this.runs.find((row) => path === `/api/application-runs/${row.id}/actions`);
      if (!run) throw new Error(`Unexpected synthetic mutation: ${path}`);
      if (run.revision !== body.expectedRevision || run.state === 'stopped' ||
          (body.action === 'resume' && run.state !== 'paused')) return error(409, 'CONFLICT');
      run.state = body.action === 'resume' ? 'running' : body.action === 'pause' ? 'paused' : 'stopped';
      run.revision++;
      if (run.state !== 'running') {
        for (const app of this.applications.filter((app) => app.runId === run.id && !isTerminalState(app.state))) {
          if (app.state === 'submitting') app.state = 'submission_unknown';
          if (run.state === 'stopped' && app.state !== 'submission_unknown') app.state = 'cancelled';
          app.reasonCode = run.state === 'paused' ? 'run_paused' : 'run_stopped'; app.revision++;
        }
      }
      result = reply(RunSchema, run);
    }
    result = structuredClone(result);
    this.acks.set(key, { input, reply: result });
    await this.afterWrite?.();
    if (this.loseNext) { this.loseNext = false; throw new TypeError('Synthetic lost acknowledgement'); }
    return result;
  }
  get writes() { return this.requests.filter((request) => request.method !== 'GET'); }
}
