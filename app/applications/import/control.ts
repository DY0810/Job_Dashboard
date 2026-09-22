import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../../lib/applications/applicant-precondition';
import {
  DiscoveryErrorSchema, DiscoveryStatusSchema, ImportAcknowledgementSchema, ImportConfirmRequestSchema,
  ImportPreviewRequestSchema, ImportPreviewSchema, type DiscoveryStatus, type ImportAcknowledgement,
  type ImportConfirmRequest, type ImportPreview, type ImportPreviewRequest,
} from '../../../lib/applications/discovery-protocol';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
type StorageReader = Pick<Storage, 'length' | 'key' | 'getItem'>;
type Pending = { kind: 'preview'; body: ImportPreviewRequest } | { kind: 'confirm'; body: ImportConfirmRequest };
export type DiscoveryView = {
  account: z.infer<typeof ApplicantSchema> | null;
  locked: boolean; busy: boolean; error: string; notice: string;
  preview: ImportPreview | null; selected: number[]; ownership: boolean; expired: boolean;
  pending: Pending | null; ack: ImportAcknowledgement | null;
  runId: string; status: DiscoveryStatus | null; statusStale: boolean;
};
export const initialDiscoveryView: DiscoveryView = {
  account: null, locked: true, busy: false, error: '', notice: '',
  preview: null, selected: [], ownership: false, expired: false, pending: null, ack: null,
  runId: '', status: null, statusStale: false,
};

export function readLegacyMarks(storage: StorageReader) {
  const postingIds: number[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (!key || !/^workie-applied:[1-9]\d*$/.test(key) || storage.getItem(key) !== '1') continue;
    const id = Number(key.slice('workie-applied:'.length));
    if (!Number.isSafeInteger(id)) continue;
    postingIds.push(id);
    if (postingIds.length > 1000) return { postingIds: [], overflow: true };
  }
  return { postingIds: postingIds.sort((a, b) => a - b), overflow: false };
}

export function safePostingUrl(value: string | null) {
  if (!value || !/^https?:\/\//i.test(value) || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

class RequestError extends Error {
  constructor(readonly status: number, readonly code = '', readonly mutationRejected = false) {
    super(code === 'PRINCIPAL_CHANGED' ? 'Account changed. Check the current applicant.' :
      code === 'PREVIEW_EXPIRED' ? 'Preview expired. Preview browser marks again; your selection is retained.' :
        status === 401 ? 'Session expired. Unlock Workie, then check the applicant session.' :
          status === 403 ? 'Applicant access denied. Check the signed-in account.' :
            status === 409 ? 'Import conflict. Review a new preview before confirming.' :
              status === 404 ? 'Preview or run no longer available.' :
                status === 400 ? 'Invalid request. Review the selected rows.' :
                  status === 429 ? 'Too many requests. Wait before retrying.' :
                    status === 503 ? 'Private service unavailable. Retry.' :
                      'Incompatible response. Check the session before retrying.');
  }
}

async function request(path: string, signal: AbortSignal, owner?: string, body?: Pending['body']): Promise<unknown> {
  const headers = new Headers();
  if (owner) headers.set(EXPECTED_APPLICANT_HEADER, owner);
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  const raw = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (!response.ok) {
    const parsed = DiscoveryErrorSchema.safeParse(raw);
    throw new RequestError(response.status, parsed.success ? parsed.data.code : undefined, !!body);
  }
  return raw;
}

const sameIds = (a: number[], b: number[]) => a.length === b.length && new Set(a).size === a.length &&
  a.every((id) => b.includes(id));

/** Transient, owner-bound UI state. No browser marks or request bodies are persisted. */
export class DiscoveryControl {
  view = { ...initialDiscoveryView };
  private operation: AbortController | null = null;
  private disposed = false;
  constructor(private readonly publish: (view: DiscoveryView) => void, private readonly expectedOwner?: string) {}

  private update(patch: Partial<DiscoveryView>) {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.publish(this.view);
  }
  private begin() {
    this.operation?.abort();
    this.operation = new AbortController();
    return this.operation.signal;
  }
  private changedOwner() {
    this.update({ ...initialDiscoveryView, error: 'Account changed. Check the current applicant.' });
    throw new RequestError(403, 'PRINCIPAL_CHANGED');
  }
  private async assertOwner(owner: string, signal: AbortSignal) {
    const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
    signal.throwIfAborted();
    if (account.ownerId !== owner) this.changedOwner();
    return account;
  }
  private async fail(error: unknown, signal: AbortSignal, owner?: string) {
    if (signal.aborted) return;
    if (error instanceof RequestError && error.status === 403 && error.code !== 'PRINCIPAL_CHANGED' && owner) {
      try { await this.assertOwner(owner, signal); } catch (next) { error = next; }
    }
    if (signal.aborted) return;
    if (error instanceof RequestError && error.code === 'PRINCIPAL_CHANGED') {
      this.update({ ...initialDiscoveryView, error: error.message });
      return;
    }
    const definitive = error instanceof RequestError && error.mutationRejected && [400, 403, 404, 409].includes(error.status);
    this.update({
      error: error instanceof RequestError ? error.message : error instanceof z.ZodError ?
        'Incompatible response. Check the session before retrying.' : 'Connection interrupted. Retry the same pending request.',
      ...(definitive ? { pending: null } : {}),
      ...(error instanceof RequestError && error.code === 'PREVIEW_EXPIRED' ? { expired: true, ownership: false } : {}),
      ...((error instanceof RequestError && [401, 403].includes(error.status)) || error instanceof z.ZodError ? { locked: true } : {}),
    });
  }
  async refreshSession() {
    if (this.disposed) return;
    const signal = this.begin();
    this.update({ busy: true, locked: true });
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
      signal.throwIfAborted();
      if (this.view.account && this.view.account.ownerId !== account.ownerId) this.update({ ...initialDiscoveryView });
      this.update({ account, locked: false, error: '' });
    } catch (error) { await this.fail(error, signal); }
    finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  suspend() {
    this.operation?.abort();
    this.update({ locked: true, busy: false });
  }
  preventNavigation() { this.update({ error: 'A request is unresolved. Retry it before leaving this page.' }); }
  storageDenied() { this.update({ error: 'Browser storage is unavailable. No marks were imported.' }); }
  select(id: number, selected: boolean) {
    if (this.view.locked || this.view.busy || this.view.pending || this.view.ack ||
        !this.view.preview?.rows.some((row) => row.postingId === id)) return;
    this.update({ selected: selected ? [...new Set([...this.view.selected, id])].sort((a, b) => a - b) :
      this.view.selected.filter((value) => value !== id) });
  }
  confirmOwnership(ownership: boolean) {
    if (!this.view.locked && !this.view.busy && !this.view.pending && !this.view.ack) this.update({ ownership });
  }
  async preview(storage: StorageReader) {
    if (this.view.locked || this.view.busy || this.view.pending) return;
    let marks;
    try { marks = readLegacyMarks(storage); } catch { this.storageDenied(); return; }
    if (marks.overflow) {
      this.update({ error: 'More than 1,000 browser marks. Nothing was sent; this import requires at most 1,000 marks.' });
      return;
    }
    if (!marks.postingIds.length) {
      this.update({ error: '', notice: 'No canonical applied marks found in this browser.' });
      return;
    }
    return this.execute({ kind: 'preview', body: ImportPreviewRequestSchema.parse({
      requestId: crypto.randomUUID(), postingIds: marks.postingIds,
    }) });
  }
  async confirm() {
    const { preview, selected, ownership, expired, ack } = this.view;
    if (!preview || !selected.length || !ownership || expired || ack) return;
    return this.execute({ kind: 'confirm', body: ImportConfirmRequestSchema.parse({
      requestId: crypto.randomUUID(), previewToken: preview.previewToken, previewHash: preview.previewHash,
      postingIds: selected, confirmOwnership: true,
    }) });
  }
  retry() { if (this.view.pending) return this.execute(this.view.pending); }
  private async execute(pending: Pending) {
    const owner = this.view.account?.ownerId;
    if (!owner || this.disposed || this.view.locked || this.view.busy ||
        (this.view.pending && this.view.pending !== pending)) return;
    const signal = this.begin();
    this.update({ pending, busy: true, error: '', notice: '' });
    try {
      await this.assertOwner(owner, signal);
      const raw = await request(`/api/applications/import/${pending.kind}`, signal, owner, pending.body);
      const result = pending.kind === 'preview' ? ImportPreviewSchema.parse(raw) : ImportAcknowledgementSchema.parse(raw);
      if (result.ownerId !== owner) this.changedOwner();
      await this.assertOwner(owner, signal);
      if (pending.kind === 'preview') {
        const preview = result as ImportPreview;
        if (!sameIds(preview.rows.map((row) => row.postingId), pending.body.postingIds)) throw new RequestError(502);
        this.update({ preview, pending: null, ack: null, expired: false, ownership: false,
          selected: this.view.selected.filter((id) => preview.rows.some((row) => row.postingId === id)) });
      } else {
        const ack = result as ImportAcknowledgement;
        const resolved = this.view.preview!.rows.filter((row) =>
          pending.body.postingIds.includes(row.postingId) && row.resolution === 'resolved').length;
        if (ack.requestId !== pending.body.requestId || ack.previewToken !== pending.body.previewToken ||
            !sameIds(ack.importedPostingIds, pending.body.postingIds) || ack.resolvedCount !== resolved ||
            ack.unresolvedCount !== pending.body.postingIds.length - resolved) throw new RequestError(502);
        this.update({ ack, pending: null, notice: 'Manual marks imported. Browser flags retained. No employer receipts created.' });
      }
    } catch (error) { await this.fail(error, signal, owner); }
    finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  selectRun(runId: string) {
    if (this.disposed || (runId && !z.uuid().safeParse(runId).success)) return;
    this.operation?.abort();
    this.update({ runId, status: null, statusStale: false, busy: false, error: '' });
  }
  async refreshStatus() {
    const { runId } = this.view;
    if (!runId || this.disposed || this.view.busy) return;
    const signal = this.begin();
    this.update({ busy: true, error: '' });
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant', signal));
      if (this.expectedOwner && account.ownerId !== this.expectedOwner) this.changedOwner();
      if (this.view.account && account.ownerId !== this.view.account.ownerId) this.changedOwner();
      const status = DiscoveryStatusSchema.parse(await request(`/api/application-runs/${runId}/discovery`, signal, account.ownerId));
      if (status.ownerId !== account.ownerId) this.changedOwner();
      if (status.runId !== runId) throw new RequestError(502);
      await this.assertOwner(account.ownerId, signal);
      this.update({ account, status, statusStale: false, locked: false });
    } catch (error) {
      await this.fail(error, signal, this.view.account?.ownerId);
      if (!signal.aborted) this.update({ statusStale: true });
    } finally { if (!signal.aborted) this.update({ busy: false }); }
  }
  dispose() {
    this.operation?.abort();
    this.disposed = true;
    this.view = { ...initialDiscoveryView };
  }
}
