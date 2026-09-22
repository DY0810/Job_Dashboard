'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { ProfileSaveError } from '@/lib/profile-drafts';
import { EXPECTED_APPLICANT_HEADER } from '@/lib/applications/applicant-precondition';
import { DOCUMENT_KINDS, DOCUMENT_MIMES, allowedDocumentMimes, documentMimeForFilename } from '@/lib/applications/document-types';
import type { PrivateApi } from './api';
import { labelFor, type DocumentOption } from './fields';
import styles from './profile.module.css';

const kinds = ['resume_master', 'resume_source', 'transcript', 'certificate', 'supporting', 'portfolio', 'artwork'] as const;
const summarySchema = z.object({
  id: z.uuid(), kind: z.enum(DOCUMENT_KINDS), name: z.string(), role: z.string().nullable(), parentId: z.uuid().nullable(),
  masterId: z.uuid(), version: z.number().int().positive(), mime: z.enum(DOCUMENT_MIMES), size: z.number().nonnegative(),
  sha256: z.string().nullable(), state: z.enum(['pending', 'quarantined', 'available', 'rejected', 'expired']),
  safetyCheck: z.enum(['pending', 'passed', 'rejected', 'deferred']), createdAt: z.string(), downloadUrl: z.string().nullable().optional(),
});
const listSchema = z.object({ documents: z.array(summarySchema), storage: z.enum(['local', 'blob', 'unconfigured']) });
const grantSchema = z.object({
  document: summarySchema, grantId: z.uuid(), pathname: z.string().min(1),
  uploadMode: z.enum(['local', 'blob']), uploadUrl: z.string(),
});
type DocumentSummary = z.infer<typeof summarySchema>;
type Grant = z.infer<typeof grantSchema>;
type PendingUpload = { requestId: string; grant?: Grant; attempted?: boolean; uploadedDoc?: DocumentSummary };

export default function DocumentsPane({ api, ownerId, signal, onDocuments, idPrefix = 'document' }: {
  api: PrivateApi; ownerId: string; signal: AbortSignal; onDocuments: (documents: DocumentOption[]) => void;
  idPrefix?: string;
}) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [storage, setStorage] = useState<'local' | 'blob' | 'unconfigured' | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<(typeof kinds)[number]>('resume_master');
  const [role, setRole] = useState('');
  const [parentId, setParentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const pending = useRef<PendingUpload | null>(null);
  const alive = useRef(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const reconcile = useCallback((work: PendingUpload, doc?: DocumentSummary) => {
    if (!alive.current || pending.current !== work || !doc || doc.id !== work.grant?.document.id || doc.state === 'pending') return false;
    pending.current = null;
    setError('');
    if (doc.state === 'available' || doc.state === 'quarantined') {
      setFile(null);
      if (fileInput.current) fileInput.current.value = '';
      setStatus('Upload received. Availability is shown in the document list.');
    } else {
      setStatus(doc.state === 'rejected' ? 'Document rejected. Choose a new file.' : 'Upload expired. Your selection is retained for a new upload.');
    }
    return true;
  }, []);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = listSchema.parse(await api('/api/documents', { signal }));
    if (!alive.current || signal?.aborted) return;
    setStorage(result.storage); setDocuments(result.documents); onDocuments(result.documents);
    const work = pending.current;
    if (work) reconcile(work, result.documents.find((doc) => doc.id === work.grant?.document.id && doc.state !== 'pending') ?? work.uploadedDoc);
  }, [api, onDocuments, reconcile]);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void refresh(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError('Could not load documents. Retry refresh.');
    });
    return () => { alive.current = false; controller.abort(); pending.current = null; };
  }, [refresh]);
  useEffect(() => {
    if (!documents.some((d) => d.state === 'pending' || d.state === 'quarantined')) return;
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh().catch(() => {});
    }, 10_000);
    return () => clearInterval(interval);
  }, [documents, refresh]);
  function edit() { pending.current = null; setError(''); setStatus(''); }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || busy) return;
    const mime = documentMimeForFilename(file.name);
    if (!mime || !allowedDocumentMimes(kind).includes(mime) || (file.type && file.type !== mime)) {
      setError('Choose a supported file with a matching content type.'); return;
    }
    if (file.size === 0 || file.size > 10 * 1024 * 1024) { setError('Choose a nonempty file no larger than 10 MB.'); return; }
    setBusy(true); setError(''); setStatus('Requesting private upload...');
    pending.current ??= { requestId: crypto.randomUUID() };
    const work = pending.current;
    try {
      if (work.attempted) {
        await refresh();
        if (!alive.current || pending.current !== work) return;
        setStatus('Upload outcome is not yet known. Refresh documents to check again; no bytes have been resent.');
        return;
      }
      work.grant ??= grantSchema.parse(await api('/api/documents', { method: 'POST',
        body: JSON.stringify({ requestId: work.requestId, kind, name: file.name, mime, size: file.size,
          ...(role.trim() ? { role: role.trim() } : {}), ...(parentId ? { parentId } : {}) }) }));
      if (!alive.current || pending.current !== work) return;
      const grant = work.grant;
      if (reconcile(work, grant.document)) { await refresh(); return; }
      setStatus('Uploading / validation pending...');
      if (grant.uploadMode === 'local') {
        if (grant.uploadUrl !== `/api/documents/uploads/${grant.grantId}`) throw new Error('Invalid private upload destination');
        work.attempted = true;
        const result = z.object({ document: summarySchema }).parse(await api(grant.uploadUrl, { method: 'PUT', headers: { 'Content-Type': mime }, body: file }));
        if (result.document.id !== grant.document.id) throw new Error('Upload response does not match its grant');
        work.uploadedDoc = result.document;
      } else {
        if (grant.uploadUrl !== '/api/documents/upload') throw new Error('Invalid private upload destination');
        const { upload } = await import('@vercel/blob/client');
        try {
          work.attempted = true;
          await upload(grant.pathname, file, {
            access: 'private', handleUploadUrl: grant.uploadUrl, clientPayload: JSON.stringify({ grantId: grant.grantId }),
            headers: { [EXPECTED_APPLICANT_HEADER]: ownerId },
            contentType: mime, multipart: false, abortSignal: signal,
          });
        } catch (e) {
          // The SDK drops HTTP status; recheck through the pane API to lock on lost access.
          await api('/api/documents');
          throw e;
        }
      }
      if (!alive.current || pending.current !== work) return;
      await refresh();
      if (pending.current === work) setStatus('Upload sent. Waiting for document status; refresh to check again.');
    } catch (e) {
      if (!alive.current) return;
      // A failed HTTP response may follow accepted bytes (including a 422 safety
      // rejection). Only the known document status can retire a consumed grant.
      if (work.attempted && !work.uploadedDoc) {
        try {
          await refresh();
          if (!alive.current || pending.current !== work) return;
        } catch { /* Retain the file and unresolved grant until status is known. */ }
      }
      if (pending.current !== work) return;
      if (e instanceof ProfileSaveError && [413, 415].includes(e.status)) work.attempted = false;
      setStatus('');
      setError(work.uploadedDoc
        ? 'Upload received, but the document list could not refresh. Refresh documents or retry status; bytes will not be uploaded again.'
        : work.attempted ? 'Upload outcome is unknown. Your selection is retained; refresh status before retrying.'
        : e instanceof ProfileSaveError && e.status === 503
        ? 'Document storage unavailable. Configure private local storage or Vercel Blob, then retry. Your selection is retained.'
        : e instanceof ProfileSaveError ? e.message : 'Upload could not be completed. Your selection is retained; refresh status before retrying.');
    } finally { if (alive.current) setBusy(false); }
  }
  async function validate(id: string) {
    setBusy(true); setError('');
    try {
      await api(`/api/documents/${id}/validate`, { method: 'POST' });
      await refresh();
    } catch (e) { if (alive.current) setError(e instanceof ProfileSaveError ? e.message : 'Validation unavailable. Retry later.'); }
    finally { if (alive.current) setBusy(false); }
  }
  return <div className={styles.entry}>
    <div className={styles.row}><h3>Document versions</h3>
      <button type="button" className={styles.button} disabled={busy} onClick={() => {
        setError(''); void refresh().catch(() => setError('Could not refresh documents.'));
      }}>Refresh documents</button>
    </div>
    {storage === 'unconfigured' && <p className={styles.alert} role="alert">
      Document storage is not configured. Configure private local storage or Vercel Blob before uploading.
    </p>}
    <form onSubmit={upload} aria-label="Upload document">
      <fieldset disabled={busy} className={styles.fields} style={{ border: 0, padding: 0 }}>
        <div className={styles.field}><label htmlFor={`${idPrefix}-file`}>Upload file (up to 10 MB)</label>
          <input ref={fileInput} id={`${idPrefix}-file`} type="file" disabled={pending.current?.attempted} accept={allowedDocumentMimes(kind).join(',')} onChange={(e) => {
            edit(); setFile(e.target.files?.[0] ?? null);
          }} /></div>
        <div className={styles.field}><label htmlFor={`${idPrefix}-kind`}>Document kind</label>
          <select id={`${idPrefix}-kind`} value={kind} disabled={pending.current?.attempted} onChange={(e) => { edit(); setParentId(''); setKind(z.enum(kinds).parse(e.target.value)); }}>
            {kinds.map((value) => <option value={value} key={value}>{labelFor(value)}</option>)}
          </select></div>
        <div className={styles.field}><label htmlFor={`${idPrefix}-role`}>Target role</label>
          <input id={`${idPrefix}-role`} value={role} disabled={pending.current?.attempted} maxLength={100} onChange={(e) => { edit(); setRole(e.target.value); }} /></div>
        <div className={styles.field}><label htmlFor={`${idPrefix}-parent`}>Previous version / associated master</label>
          <select id={`${idPrefix}-parent`} value={parentId} disabled={pending.current?.attempted} onChange={(e) => { edit(); setParentId(e.target.value); }}>
            <option value="">New document</option>
            {documents.filter((d) => d.state === 'available' && d.kind === kind).map((d) => <option key={d.id} value={d.id}>{d.name} / v{d.version} / {labelFor(d.kind)}</option>)}
          </select></div>
        <div><button className={styles.button} type="submit" disabled={!file || storage === 'unconfigured' || storage === null}>
          {busy ? 'Uploading...' : pending.current ? 'Retry upload' : 'Upload document'}
        </button></div>
      </fieldset>
    </form>
    {status && <p role="status" className={styles.muted}>{status}</p>}
    {error && <p role="alert" className={styles.alert}>{error}</p>}
    {storage === null && !error ? <p role="status" className={styles.muted}>Loading documents...</p> :
      documents.length === 0 ? <p className={styles.muted}>No documents.</p> : <table className={styles.table}>
      <thead><tr><th style={{ width: '40%' }}>Document / role</th><th>Kind / version</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{documents.map((d) => <tr key={d.id}>
        <td>{d.name}<div className={styles.muted}>{d.role ?? 'No role assigned'}</div>
          {d.parentId && <div className={styles.muted}>Source: {documents.find((parent) => parent.id === d.parentId)?.name ?? d.parentId}</div>}</td>
        <td>{labelFor(d.kind)} / v{d.version}<div className={styles.muted}>{Math.ceil(d.size / 1024)} KB</div></td>
        <td>{labelFor(d.state)}<div className={styles.muted}>Safety: {labelFor(d.safetyCheck)}</div></td>
        <td>{d.state === 'available' && <a href={`/api/documents/${d.id}/download`}>Download</a>}
          {d.state === 'quarantined' && <button type="button" className={styles.button} disabled={busy} onClick={() => void validate(d.id)}>Retry validation</button>}
          {d.state === 'rejected' && <span>Choose a new file</span>}
          {d.state === 'expired' && <span>Start a new upload</span>}</td>
      </tr>)}</tbody>
    </table>}
  </div>;
}
