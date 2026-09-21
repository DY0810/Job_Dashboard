'use client';

import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PolicySchema, type Policy, type PolicyResponse } from '@/lib/applications/policy';
import { ProfileSaveError } from '@/lib/profile-drafts';
import { labelFor, NativeValue, type FieldMeta } from './fields';
import type { PrivateApi } from './api';
import styles from './profile.module.css';

const responseSchema = z.object({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});
const metadata = z.toJSONSchema(PolicySchema) as FieldMeta;

function PolicyFields({ meta, value, onChange, path = 'policy' }: {
  meta: FieldMeta; value: Record<string, unknown>; onChange: (value: Record<string, unknown>) => void; path?: string;
}) {
  return <div className={styles.fields}>
    {Object.entries(meta.properties ?? {}).filter(([key]) => !['schemaVersion', 'allowUnknownCost'].includes(key)).map(([key, node]) => {
      const id = `${path}-${key}`;
      const change = (next: unknown) => onChange({ ...value, [key]: next });
      if (node.type === 'object') return <fieldset className={styles.collection} key={key}>
        <legend>{labelFor(key)}</legend><PolicyFields meta={node} value={value[key] as Record<string, unknown>}
          path={id} onChange={change} />
      </fieldset>;
      if (node.type === 'boolean') return <div className={styles.field} key={key}>
        <label className={styles.row}><input type="checkbox" checked={value[key] === true}
          onChange={(e) => change(e.target.checked)} />{labelFor(key)}</label>
      </div>;
      return <div className={styles.field} key={key}>
        <label htmlFor={id}>{labelFor(key)}{['perRequest', 'perRun', 'perDay'].includes(key) ? ` (${value.currency})` : ''}</label>
        {key === 'expiresAt' ? <input id={id} type="datetime-local" value={typeof value[key] === 'string'
          ? new Date(new Date(value[key] as string).getTime() - new Date(value[key] as string).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''}
          onChange={(e) => change(e.target.value ? new Date(e.target.value).toISOString() : null)} /> :
          <NativeValue meta={node} value={value[key]} onChange={change} id={id} label={`Policy: ${labelFor(key)}`} />}
      </div>;
    })}
  </div>;
}

export default function PolicyPane({ api, profileSaved }: { api: PrivateApi; profileSaved: boolean }) {
  const [saved, setSaved] = useState<PolicyResponse | null>(null);
  const [draft, setDraft] = useState<Policy | null>(null);
  const desired = useRef<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [conflict, setConflict] = useState<PolicyResponse | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const pending = useRef<{ method: 'PATCH' | 'POST'; body: Record<string, unknown>; ack?: PolicyResponse } | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    generation.current++;
    const controller = new AbortController();
    api('/api/auto-apply/policies', { signal: controller.signal }).then((body) => {
      if (controller.signal.aborted) return;
      const data = responseSchema.parse(body);
      setSaved(data); setDraft(data.policy); desired.current = data.policy;
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load policy. Retry loading.'); });
    return () => { mounted.current = false; controller.abort(); desired.current = null; pending.current = null; };
  }, [api]);
  async function load() {
    const epoch = ++generation.current;
    setBusy(true);
    try {
      const data = responseSchema.parse(await api('/api/auto-apply/policies'));
      if (!mounted.current || epoch !== generation.current) return;
      setSaved(data);
      if (!draft) { setDraft(data.policy); desired.current = data.policy; }
      else setConflict(data);
      setError('');
    } catch { if (mounted.current && epoch === generation.current) setError('Policy could not be loaded. Retry.'); }
    finally { if (mounted.current && epoch === generation.current) setBusy(false); }
  }
  async function command(action: 'save' | 'enable' | 'disable') {
    if (!saved || !draft || (action === 'disable' ? disabling : busy)) return;
    const epoch = ++generation.current;
    const current = () => mounted.current && epoch === generation.current;
    // Disable cancels local intent, not the server request. Its CAS write fences any
    // delayed enable, even when the current head is already disabled.
    if (action === 'disable') pending.current = null;
    const work = pending.current ?? {
      method: action === 'save' ? 'PATCH' as const : 'POST' as const,
      body: action === 'save' ? { expectedRevision: saved.revision, requestId: crypto.randomUUID(), policy: draft } :
        { expectedRevision: saved.revision, requestId: crypto.randomUUID(), action,
          ...(action === 'enable' ? { acceptedPolicyHash: saved.policyHash } : {}) },
    };
    pending.current = work;
    setBusy(true); setDisabling(work.body.action === 'disable'); setError(''); setNotice('');
    try {
      for (let attempt = 0; !work.ack; attempt++) {
        if (work.body.action === 'disable' && (action === 'disable' || attempt > 0)) {
          const head = responseSchema.parse(await api('/api/auto-apply/policies'));
          if (!current()) return;
          work.body = { action: 'disable', expectedRevision: head.revision, requestId: crypto.randomUUID() };
        }
        try {
          work.ack = responseSchema.parse(await api('/api/auto-apply/policies', { method: work.method, body: JSON.stringify(work.body) }));
        } catch (e) {
          if (!current()) return;
          if (work.body.action === 'disable' && e instanceof ProfileSaveError && e.status === 409 && attempt < 2) continue;
          throw e;
        }
        if (!current()) return;
      }
      const response = responseSchema.parse(await api('/api/auto-apply/policies'));
      if (!current()) return;
      if (response.revision < work.ack.revision) throw new Error('Policy head is older than the acknowledgement');
      setSaved(response);
      if (work.method === 'PATCH' && response.revision === work.ack.revision &&
          JSON.stringify(desired.current) === JSON.stringify(work.body.policy)) {
        setDraft(response.policy); desired.current = response.policy;
      }
      setConflict(JSON.stringify(response.policy) !== JSON.stringify(work.ack.policy) ? response : null);
      pending.current = null; setUncertain(false); setAccepted(false);
      setNotice(response.revision > work.ack.revision
        ? `Earlier request acknowledged. Current policy version ${response.policyVersion}: ${response.enabled ? 'enabled intent' : 'Auto Apply disabled'}.`
        : response.enabled ? `Policy version ${response.policyVersion} accepted. ${response.runnerAvailable ? 'Runner online.' : 'Runner offline.'}` : `Policy version ${response.policyVersion} saved. Auto Apply disabled.`);
    } catch (e) {
      if (!current()) return;
      setError(e instanceof ProfileSaveError ? e.message : 'Policy request failed. Retry the same request.');
      if (e instanceof ProfileSaveError && e.status === 409) {
        const latest = responseSchema.safeParse(e.current);
        if (latest.success) setConflict(latest.data);
        else {
          try {
            const current = responseSchema.parse(await api('/api/auto-apply/policies'));
            if (mounted.current && epoch === generation.current) { setSaved(current); setConflict(current); }
          } catch { if (mounted.current && epoch === generation.current) setError('Policy conflict. Check saved policy to review.'); }
        }
        if (!current()) return;
        pending.current = null; setUncertain(false);
      } else if (e instanceof ProfileSaveError && [400, 413, 415].includes(e.status)) {
        pending.current = null; setUncertain(false);
      } else setUncertain(true);
    } finally { if (current()) { setBusy(false); setDisabling(false); } }
  }
  const valid = draft && PolicySchema.safeParse(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved?.policy);
  useEffect(() => {
    const pendingChanges = () => !!pending.current || !!(saved && desired.current && JSON.stringify(desired.current) !== JSON.stringify(saved.policy));
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingChanges()) { event.preventDefault(); event.returnValue = ''; }
    };
    const navigation = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || link.target === '_blank' || link.download || event.metaKey || event.ctrlKey ||
          new URL(link.href).pathname === '/profile' || !pendingChanges()) return;
      event.preventDefault(); event.stopPropagation();
      setError('Policy changes are pending. Save or resolve the pending request before leaving.');
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', navigation, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', navigation, true);
    };
  }, [saved]);
  return <section className={styles.section} id="auto-apply-policy" aria-labelledby="policy-heading">
    <div className={styles.row}><h2 id="policy-heading">Auto Apply policy</h2>
      <span className={styles.muted}>{saved?.enabled ? 'Enabled intent' : 'Disabled'} / {saved?.runnerAvailable ? 'Runner online' : 'Runner offline'}</span>
    </div>
    {!draft ? error ? <button className={styles.button} disabled={busy} onClick={() => void load()}>Retry loading policy</button> :
      <p className={styles.muted} role="status">Loading policy...</p> :
      <form onSubmit={(e) => { e.preventDefault(); void command('save'); }}>
        <fieldset disabled={busy} className={styles.field}>
          <PolicyFields meta={metadata} value={draft} onChange={(next) => {
            setDraft(next as Policy); desired.current = next as Policy; setAccepted(false); setNotice('');
          }} />
        </fieldset>
        <p className={styles.muted}>Unknown-cost providers: blocked.</p>
        {valid && !valid.success && <ul aria-label="Policy validation" className={styles.error}>
          {valid.error.issues.map((issue, index) => <li key={index}>{issue.path.map(String).map(labelFor).join(' / ')}: {issue.message}</li>)}
        </ul>}
        {conflict && <div className={styles.alert}>
          <p>Policy changed to version {conflict.policyVersion}. Saving this draft will disable Auto Apply.</p>
          <details><summary>Current saved policy</summary>
            <fieldset disabled className={styles.field}><PolicyFields meta={metadata} value={conflict.policy} path="current-policy" onChange={() => {}} /></fieldset>
          </details>
          <div className={styles.row}>
            <button type="button" className={styles.button} onClick={() => { setSaved(conflict); setConflict(null); setAccepted(false); setError(''); }}>Keep draft for review</button>
            <button type="button" className={styles.button} onClick={() => {
              setSaved(conflict); setDraft(conflict.policy); desired.current = conflict.policy; setConflict(null); setAccepted(false); setError('');
            }}>Use saved policy</button>
          </div>
        </div>}
        <div className={styles.row}>
          <button className={styles.button} type="submit" disabled={busy || !!conflict || !valid?.success || uncertain}>Save policy</button>
          {uncertain && <button type="button" className={styles.button} disabled={busy} onClick={() => void command('save')}>Retry policy request</button>}
          <button className={styles.button} type="button" disabled={busy} onClick={() => void load()}>Check saved policy</button>
        </div>
        {saved?.policyHash && !dirty && !conflict && !saved.enabled && <div className={styles.entry}>
          <label className={styles.row}>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} disabled={busy || uncertain} />
            Accept policy version {saved.policyVersion}
          </label>
          <p className={styles.muted}>Policy fingerprint: {saved.policyHash}</p>
          <button className={styles.button} type="button" disabled={busy || !accepted || !profileSaved || uncertain}
            onClick={() => void command('enable')}>Enable Auto Apply</button>
        </div>}
        <button className={styles.button} type="button" disabled={disabling} onClick={() => void command('disable')}>Disable Auto Apply</button>
      </form>}
    {error && <p role="alert" className={styles.alert}>{error}</p>}
    {notice && <p role="status" className={styles.muted}>{notice}</p>}
  </section>;
}
