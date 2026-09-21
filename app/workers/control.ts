import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition.ts';
import { PolicySchema } from '../../lib/applications/policy.ts';
import { isTerminalState } from '../../lib/applications/state.ts';
import {
  ApplicationCommandSchema, ApplicationSummarySchema, HEARTBEAT_MS, PairingCreateSchema,
  PairingGrantSchema, RevisionCommandSchema, RevocationSchema, RunCommandSchema, RunCreateSchema,
  RunListSchema, RunSchema, WorkerListSchema,
  type ApplicationCommand, type ApplicationSummary, type PairingGrant, type PairingSummary,
  type Run, type RunList, type WorkerList, type WorkerSummary,
} from '../../lib/applications/worker-protocol.ts';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.literal(false),
});
type Kind = 'pairing' | 'worker' | 'run' | 'application';
type Command = {
  kind: Kind; path: string; method: 'POST' | 'DELETE'; title: string;
  body: { requestId: string; expectedRevision: number; label?: string; workerId?: string; action?: string };
  id?: string; ack?: { id: string; revision: number };
};
export type WorkerView = {
  account: z.infer<typeof ApplicantSchema> | null;
  workers: WorkerList | null; runs: RunList | null;
  policy: z.infer<typeof PolicyResponseSchema> | null;
  locked: boolean; loading: boolean; busy: boolean; error: string; notice: string;
  pending: Command | null; grant: PairingGrant | null; now: number;
};
export const initialView: WorkerView = {
  account: null, workers: null, runs: null, policy: null, locked: true, loading: true,
  busy: false, error: '', notice: '', pending: null, grant: null, now: 0,
};

export function pairingStatus(pairing: PairingSummary, now: number) {
  return pairing.revokedAt !== null ? 'Cancelled' : pairing.consumedAt !== null ? 'Paired' :
    pairing.expiresAt <= now ? 'Expired' : 'Unpaired';
}
export function workerStatus(worker: WorkerSummary, now: number) {
  return worker.revokedAt !== null ? 'Revoked' : worker.online && worker.lastSeenAt !== null &&
    now >= worker.lastSeenAt && now - worker.lastSeenAt < HEARTBEAT_MS * 3 ? 'Online' : 'Offline';
}
export function applicationActions(app: ApplicationSummary, run?: Run): ApplicationCommand['action'][] {
  if (isTerminalState(app.state)) return [];
  if (app.state === 'submitting' || app.state === 'submission_unknown') return ['emergency-stop'];
  const actions: ApplicationCommand['action'][] = ['skip', 'cancel'];
  // Retry budget remains server-authoritative; it is not part of the summary.
  if (run && run.state !== 'stopped' && app.checkpoint &&
      ['provider_unavailable', 'retryable_failure'].includes(app.state)) actions.push('retry-safe');
  return actions;
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code === 'GRANT_UNAVAILABLE' ? 'Pairing already created; its secret is unavailable. Cancel the unused grant before creating another.' :
      code === 'PRINCIPAL_CHANGED' ? 'Account changed. Refresh the current applicant.' :
        code === 'AUTH_FORBIDDEN' ? 'Applicant access denied.' :
          status === 401 ? 'Session expired. Sign in and refresh.' :
            status === 503 ? 'Private service unavailable. Check configuration and retry.' :
              code === 'EXECUTION_DISABLED' ? 'Execution is disabled.' :
                status === 409 ? 'State changed. Current state must be reviewed before another action.' :
                status === 429 ? 'Too many requests. Wait before retrying.' :
                    status === 403 ? 'Action not permitted by the current worker or policy.' :
                      status === 404 ? 'Record no longer available. Refresh current state.' :
                        status === 400 ? 'Invalid request. Check the fields.' : 'Incompatible worker response. Refresh before continuing.');
  }
}

async function request(path: string, signal: AbortSignal, owner?: string, command?: Command): Promise<unknown> {
  const headers = new Headers();
  if (owner) headers.set(EXPECTED_APPLICANT_HEADER, owner);
  if (command) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    method: command?.method ?? 'GET', headers, body: command ? JSON.stringify(command.body) : undefined,
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const body = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    const code = path === '/api/auth/applicant' && response.status === 403 ? 'AUTH_FORBIDDEN' :
      typeof body?.code === 'string' ? body.code : '';
    // Older private endpoints return an untagged 403 for a principal mismatch.
    if (owner && response.status === 403 && code !== 'PRINCIPAL_CHANGED') {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
      if (account.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
    }
    // Never render arbitrary server errors: a malformed response may echo secrets.
    throw new RequestError(response.status, code);
  }
  return body;
}

/** One tab's transient command state. Durable truth is always fetched from the server. */
export class WorkerControl {
  view = { ...initialView };
  private operation: AbortController | null = null;
  private disposed = false;
  private superseded: Command[] = [];
  private sampledAt: number | null = null;
  private serverTime = 0;

  constructor(private readonly publish: (view: WorkerView) => void) {}

  private currentTime() {
    return this.sampledAt === null ? 0 : this.serverTime + Math.max(0, performance.now() - this.sampledAt);
  }
  private update(patch: Partial<WorkerView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch, now: this.currentTime() };
    if (this.view.grant && this.view.grant.expiresAt <= this.view.now) {
      this.view = { ...this.view, grant: null, notice: 'Pairing grant expired.' };
    }
    this.publish(this.view);
  }
  private begin() {
    this.operation?.abort();
    this.operation = new AbortController();
    return this.operation.signal;
  }
  private clearOwner() {
    this.superseded = [];
    this.sampledAt = null;
    this.serverTime = 0;
    this.update({ ...initialView, loading: false });
  }
  private async assertOwner(owner: string, signal: AbortSignal) {
    const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
    signal.throwIfAborted();
    if (account.ownerId !== owner) {
      this.clearOwner();
      this.operation?.abort();
      this.update({ error: 'Account changed. Refresh the current applicant.' });
      throw new RequestError(403, 'PRINCIPAL_CHANGED');
    }
  }
  private fail(error: unknown) {
    if (error instanceof RequestError && error.code === 'PRINCIPAL_CHANGED') {
      this.clearOwner();
      this.operation?.abort();
    }
    this.update({
      error: error instanceof RequestError ? error.message :
        error instanceof z.ZodError ? 'Incompatible worker response. Controls are locked until refresh.' :
          'Connection interrupted. Refresh status or retry the pending request.',
      ...((error instanceof RequestError && (error.status === 401 ||
        ['AUTH_FORBIDDEN', 'PRINCIPAL_CHANGED'].includes(error.code))) || error instanceof z.ZodError ? { locked: true } : {}),
    });
  }
  private async head(owner: string, signal: AbortSignal) {
    // Request start is conservative: neither transport nor later reads add TTL.
    const sampledAt = performance.now();
    const workers = WorkerListSchema.parse(await request('/api/workers', signal, owner));
    if (workers.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
    const runs = RunListSchema.parse(await request('/api/application-runs', signal, owner));
    if (runs.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
    const policy = PolicyResponseSchema.parse(await request('/api/auto-apply/policies', signal, owner));
    await this.assertOwner(owner, signal);
    this.sampledAt = sampledAt;
    this.serverTime = workers.serverTime;
    let grant = this.view.grant;
    const pairing = workers.pairings.find((row) => row.id === grant?.pairingId);
    if (grant && (!pairing || pairingStatus(pairing, this.currentTime()) !== 'Unpaired')) grant = null;
    this.update({ workers, runs, policy, grant });
    return { workers, runs };
  }
  async refresh(quiet = false) {
    if (this.disposed) return;
    const signal = this.begin();
    this.update({ loading: true, ...(!quiet ? { locked: true } : {}), busy: false });
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
      signal.throwIfAborted();
      if (this.view.account && this.view.account.ownerId !== account.ownerId) this.clearOwner();
      this.update({ account });
      await this.head(account.ownerId, signal);
      this.update({ locked: false, error: '' });
    } catch (error) {
      if (!signal.aborted) {
        this.fail(error);
        if (!quiet) this.update({ locked: true });
      }
    } finally {
      if (!signal.aborted) this.update({ loading: false });
    }
  }
  suspend() {
    this.operation?.abort();
    this.update({ locked: true, loading: false, busy: false });
  }
  tick() {
    if (this.sampledAt !== null) this.update({});
  }
  clearSecret() { this.update({ grant: null, notice: 'Pairing secret dismissed.' }); }
  preventNavigation() { this.update({ error: 'A request is unresolved. Retry it before leaving this page.' }); }
  async copySecret() {
    this.tick();
    const grant = this.view.grant;
    if (this.view.locked || !grant || grant.expiresAt <= this.view.now) return;
    try {
      await this.assertOwner(grant.ownerId, this.operation?.signal ?? new AbortController().signal);
    } catch (error) {
      if (this.view.grant === grant) { this.fail(error); this.update({ locked: true }); }
      return;
    }
    this.tick();
    if (this.view.locked || this.view.grant !== grant || grant.expiresAt <= this.view.now) return;
    try {
      await navigator.clipboard.writeText(grant.grant);
      if (this.view.grant === grant && !this.view.locked) this.update({ notice: 'Pairing grant copied.' });
    } catch {
      if (this.view.grant === grant && !this.view.locked) this.update({ error: 'Clipboard unavailable. Select the pairing grant to copy.' });
    }
  }
  createPairing(label: string) {
    const parsed = PairingCreateSchema.safeParse({ requestId: crypto.randomUUID(), expectedRevision: 0, label });
    if (!parsed.success) { this.update({ error: 'Worker label must contain 1 to 80 characters.' }); return; }
    return this.execute({ kind: 'pairing', path: '/api/workers/pairings', method: 'POST', title: 'Create pairing grant', body: parsed.data });
  }
  revoke(kind: 'worker' | 'pairing', row: WorkerSummary | PairingSummary) {
    return this.execute({ kind, id: row.id, path: `/api/workers/${kind === 'pairing' ? 'pairings/' : ''}${row.id}`,
      method: 'DELETE', title: kind === 'worker' ? 'Revoke worker' : 'Cancel pairing',
      body: RevisionCommandSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: row.revision }) });
  }
  createRun(workerId: string) {
    if (!this.view.policy?.enabled || !this.view.workers?.workers.some((w) => w.id === workerId && w.revokedAt === null)) return;
    return this.execute({ kind: 'run', path: '/api/application-runs', method: 'POST', title: 'Create run',
      body: RunCreateSchema.parse({ workerId, requestId: crypto.randomUUID(), expectedRevision: 0 }) });
  }
  commandRun(run: Run, action: 'pause' | 'resume' | 'stop' | 'emergency-stop') {
    return this.execute({ kind: 'run', id: run.id, path: `/api/application-runs/${run.id}/actions`, method: 'POST',
      title: action === 'emergency-stop' ? 'Emergency stop' : `${action[0].toUpperCase()}${action.slice(1)} run`,
      body: RunCommandSchema.parse({ action, requestId: crypto.randomUUID(), expectedRevision: run.revision }) });
  }
  commandApplication(app: ApplicationSummary, action: ApplicationCommand['action']) {
    if (!applicationActions(app, this.view.runs?.runs.find((run) => run.id === app.runId)).includes(action)) return;
    return this.execute({ kind: 'application', id: app.id,
      path: `/api/application-runs/${app.runId}/applications/${app.id}/actions`, method: 'POST',
      title: action === 'emergency-stop' ? 'Emergency stop' : `${action} application`,
      body: ApplicationCommandSchema.parse({ action, requestId: crypto.randomUUID(), expectedRevision: app.revision }) });
  }
  retry() {
    if (this.view.pending) return this.execute(this.view.pending);
  }
  private finish(work: Command, revision = 0) {
    // Only a confirmed revision on the exact mutation target fences older intent.
    if (work.body.action === 'emergency-stop') {
      this.superseded = this.superseded.filter((pending) =>
        pending.kind !== work.kind || pending.path !== work.path || pending.body.expectedRevision >= revision);
    }
    this.update({ pending: this.superseded.pop() ?? null });
  }
  private async execute(work: Command) {
    const owner = this.view.account?.ownerId;
    const emergency = work.body.action === 'emergency-stop';
    if (!owner || this.view.locked || this.disposed ||
        (this.view.pending && this.view.pending !== work && !emergency)) return;
    const retry = this.view.pending === work;
    if (this.view.pending && !retry) this.superseded.push(this.view.pending);
    const signal = this.begin();
    this.update({ pending: work, busy: true, error: '', notice: '' });
    try {
      await this.assertOwner(owner, signal);
      if (emergency && !retry) {
        const head = await this.head(owner, signal);
        const current = (work.kind === 'run' ? head.runs.runs : head.runs.applications).find((row) => row.id === work.id);
        if (!current) throw new RequestError(404, 'NOT_FOUND');
        if (current.state === 'stopped') {
          this.finish(work, current.revision);
          this.update({ notice: 'Run is already stopped. Current state loaded.' });
          return;
        }
        work.body = { ...work.body, expectedRevision: current.revision };
      }
      if (!work.ack) {
        const raw = await request(work.path, signal, owner, work);
        await this.assertOwner(owner, signal);
        if (work.kind === 'pairing' && work.method === 'POST') {
          const grant = PairingGrantSchema.parse(raw);
          if (grant.ownerId !== owner) throw new RequestError(403, 'PRINCIPAL_CHANGED');
          work.ack = { id: grant.pairingId, revision: grant.revision };
          this.update({ grant });
        } else {
          const ack = (work.method === 'DELETE' ? RevocationSchema :
            work.kind === 'run' ? RunSchema : ApplicationSummarySchema).parse(raw);
          if (work.id && ack.id !== work.id) throw new RequestError(502, 'INVALID_ACK');
          work.ack = { id: ack.id, revision: ack.revision };
        }
      }
      const head = await this.head(owner, signal);
      const rows = work.kind === 'pairing' ? head.workers.pairings : work.kind === 'worker' ? head.workers.workers :
        work.kind === 'run' ? head.runs.runs : head.runs.applications;
      const current = rows.find((row) => row.id === work.ack!.id);
      if (!current || current.revision < work.ack.revision) throw new RequestError(502, 'INVALID_HEAD');
      this.finish(work, current.revision);
      this.update({ notice: current.revision > work.ack.revision ?
        'Earlier request acknowledged. Current state loaded.' : `${work.title} acknowledged. Current state loaded.` });
    } catch (error) {
      if (signal.aborted) return;
      this.fail(error);
      if (error instanceof RequestError && [400, 403, 404, 409, 426].includes(error.status) && this.view.account?.ownerId === owner) {
        try {
          await this.head(owner, signal);
          this.finish(work);
        } catch (next) {
          if (!signal.aborted) this.fail(next);
        }
      }
    } finally {
      if (!signal.aborted) this.update({ busy: false });
    }
  }
  dispose() {
    this.operation?.abort();
    this.superseded = [];
    this.sampledAt = null;
    this.serverTime = 0;
    this.disposed = true;
    this.view = { ...initialView };
  }
}
