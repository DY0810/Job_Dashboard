'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { PROFILE_FIELD_METADATA, PROFILE_SCHEMA_VERSION, PROFILE_SECTION_LABELS, ProfileSchema, type Profile, type ProfileResponse, type ProfileSection } from '@/lib/applications/profile';
import { DraftVault, ProfileSaveError, RevisionWriter, unlockDraftKey, type DraftSnapshot } from '@/lib/profile-drafts';
import { completion, labelFor, SectionFields, type DocumentOption, type FieldIssues, type FieldMeta } from './fields';
import { privateJson, type PrivateApi } from './api';
import DocumentsPane from './documents-pane';
import PolicyPane from './policy-pane';
import styles from './profile.module.css';

const applicantSchema = z.object({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const responseSchema = z.object({ ownerId: z.string().min(1), revision: z.number().int().nonnegative(), profile: ProfileSchema });
const keySchema = z.object({ ownerId: z.string().min(1), keyVersion: z.string().regex(/^[1-9]\d*$/), key: z.string() });
const sections = Object.keys(PROFILE_SECTION_LABELS) as ProfileSection[];
const metadata = PROFILE_FIELD_METADATA as FieldMeta;
type Session = {
  ownerId: string; keyVersion: string; abort: AbortController; api: PrivateApi;
  writer: RevisionWriter<Profile>; vault: DraftVault | null;
};
type Recovery = { slot: string; snapshot: DraftSnapshot<Profile> };

function draftSnapshot(value: unknown): DraftSnapshot<Profile> {
  const parsed = z.object({
    revision: z.number().int().nonnegative(), acknowledged: ProfileSchema,
    // Invalid values under active editing must survive, but the structural contract cannot change.
    desired: z.object({ schemaVersion: z.literal(1) }).passthrough(),
    pending: z.object({ expectedRevision: z.number().int().nonnegative(), requestId: z.uuid(), profile: ProfileSchema }).nullable(),
  }).parse(value);
  function structure(actual: unknown, meta: FieldMeta): boolean {
    if (!actual || typeof actual !== 'object') return false;
    if (meta.fact) {
      const fact = actual as Record<string, unknown>;
      return typeof fact.id === 'string' && typeof fact.version === 'number' &&
        ['unknown', 'declined', 'not_applicable', 'candidate', 'confirmed'].includes(String(fact.state)) &&
        !!fact.scope && typeof fact.scope === 'object' && !!fact.provenance && typeof fact.provenance === 'object';
    }
    if (meta.type === 'array') return Array.isArray(actual) && actual.length <= 100 && actual.every((entry) => structure(entry, meta.items!));
    return Object.entries(meta.properties ?? {}).every(([key, child]) =>
      ['schemaVersion', 'id', 'version'].includes(key) || structure((actual as Record<string, unknown>)[key], child));
  }
  if (!structure(parsed.desired, metadata)) throw new Error('Incompatible draft structure');
  return parsed as DraftSnapshot<Profile>;
}

function differences(mine: unknown, server: unknown, prefix = ''): { path: string; mine: string; server: string }[] {
  if (JSON.stringify(mine) === JSON.stringify(server)) return [];
  function show(value: unknown): string {
    if (value == null) return 'Not answered';
    if (typeof value !== 'object') return String(value);
    if ('state' in value) {
      const fact = value as { state: string; value: unknown };
      return `${labelFor(fact.state)}: ${show(fact.value)}`;
    }
    return Object.entries(value).filter(([key]) => !['id', 'version', 'confirmedAt'].includes(key))
      .map(([key, next]) => `${labelFor(key)} ${show(next)}`).join('; ');
  }
  if (!mine || !server || typeof mine !== 'object' || typeof server !== 'object' || 'state' in mine || Array.isArray(mine)) {
    return [{ path: prefix, mine: show(mine), server: show(server) }];
  }
  return Object.entries(mine).flatMap(([key, value]) => ['id', 'version'].includes(key) ? [] :
    differences(value, (server as Record<string, unknown>)[key], prefix ? `${prefix} / ${labelFor(key)}` : labelFor(key)));
}

export default function ProfileEditor() {
  const current = useRef<Session | null>(null);
  const unlockRef = useRef<() => void>(() => {});
  const [session, setSession] = useState<Session | null>(null);
  const [, redraw] = useState(0);
  const [locked, setLocked] = useState(true);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [draftError, setDraftError] = useState('');
  const [recoveries, setRecoveries] = useState<Recovery[]>([]);
  const [documents, setDocuments] = useState<DocumentOption[]>([]);

  useEffect(() => {
    let alive = true;
    let check: AbortController | null = null;
    function dispose() {
      const old = current.current;
      current.current = null;
      old?.abort.abort();
      old?.writer.dispose();
      old?.vault?.dispose();
      setSession(null);
      setRecoveries([]);
      setDocuments([]);
      setDraftError('');
    }
    function lock(message: string) {
      if (!alive) return;
      setLocked(true);
      setError(message);
    }
    async function unlock() {
      check?.abort();
      check = new AbortController();
      const signal = check.signal;
      setLocked(true);
      setChecking(true);
      setError('');
      current.current?.writer.pause();
      try {
        const account = applicantSchema.parse(await privateJson('/api/auth/applicant', { signal }));
        if (!alive || signal.aborted) return;
        if (current.current && current.current.ownerId !== account.ownerId) dispose();
        const response = responseSchema.parse(await privateJson('/api/profile', { signal }, account.ownerId));
        if (response.ownerId !== account.ownerId) { dispose(); throw new Error('Account changed. Unlock again.'); }
        let key: z.infer<typeof keySchema> | null = null;
        let cryptoKey: CryptoKey | null = null;
        try {
          key = keySchema.parse(await privateJson('/api/profile/draft-key', { signal }, account.ownerId));
          if (key.ownerId !== account.ownerId) { dispose(); throw new ProfileSaveError('Account changed. Unlock again.', 401); }
          cryptoKey = await unlockDraftKey(key.key);
        } catch (e) {
          if (e instanceof ProfileSaveError && [401, 403].includes(e.status)) throw e;
          setDraftError('Encrypted recovery unavailable. Configure the draft encryption key, then unlock again. Keep this tab open until saved.');
        }
        if (!alive || signal.aborted) return;
        const finalAccount = applicantSchema.parse(await privateJson('/api/auth/applicant', { signal }));
        if (!alive || signal.aborted) return;
        if (finalAccount.ownerId !== account.ownerId) { dispose(); throw new ProfileSaveError('Account changed. Unlock again.', 401); }
        const previous = current.current;
        if (previous) {
          if (key && (previous.keyVersion !== key.keyVersion || !previous.vault)) {
            previous.vault?.dispose();
            previous.vault = cryptoKey ? new DraftVault(localStorage, account.ownerId, PROFILE_SCHEMA_VERSION, key.keyVersion, cryptoKey) : null;
            previous.keyVersion = key.keyVersion;
          }
          const snapshot = previous.writer.snapshot();
          if (snapshot.pending) previous.writer.retry();
          else if (response.revision !== snapshot.revision && previous.writer.dirty) {
            previous.writer.pause(new ProfileSaveError('A newer profile exists. Review your draft.', 409, response));
          } else if (!previous.writer.dirty) previous.writer.reconcile(response, false);
          else previous.writer.retry();
          setLocked(false);
          return;
        }
        const abort = new AbortController();
        const item = { ownerId: account.ownerId, keyVersion: key?.keyVersion ?? '', abort, vault: null } as unknown as Session;
        const assertOwner = async (requestSignal: AbortSignal) => {
          const identity = applicantSchema.parse(await privateJson('/api/auth/applicant', { signal: requestSignal }));
          if (identity.ownerId !== item.ownerId) {
            if (current.current === item) { dispose(); lock('Account changed. Unlock the current account.'); }
            throw new ProfileSaveError('Account changed. Unlock the current account.', 401);
          }
          if (current.current !== item) throw new DOMException('Cancelled', 'AbortError');
        };
        item.api = async (path, init = {}) => {
          const requestSignal = init.signal ? AbortSignal.any([abort.signal, init.signal]) : abort.signal;
          try {
            await assertOwner(requestSignal);
            const result = await privateJson(path, { ...init, signal: requestSignal }, item.ownerId);
            await assertOwner(requestSignal);
            return result;
          } catch (e) {
            if (current.current === item && e instanceof ProfileSaveError && [401, 403].includes(e.status)) {
              item.writer.pause(e);
              lock(e.message);
            }
            throw e;
          }
        };
        const changed = () => {
          if (!alive || current.current !== item) return;
          redraw((n) => n + 1);
          if (item.vault) {
            void item.vault.save(item.writer.snapshot()).then((stored) => {
              if (stored && alive && current.current === item) { setDraftError(''); redraw((n) => n + 1); }
            }).catch(() => {
              if (alive && current.current === item) setDraftError('Encrypted draft could not be stored. Keep this tab open and retry saving.');
            });
          }
        };
        item.writer = new RevisionWriter(response, async (request, requestSignal) => {
          const validated = ProfileSchema.safeParse(request.profile);
          if (!validated.success) throw new ProfileSaveError('Correct the marked fields before saving.', 400);
          let ack: ProfileResponse;
          try {
            ack = responseSchema.parse(await item.api('/api/profile', {
              method: 'PATCH', signal: requestSignal, body: JSON.stringify(request),
            }));
          } catch (e) {
            if (e instanceof ProfileSaveError && e.status === 409) {
              const latest = responseSchema.parse(await item.api('/api/profile', { signal: requestSignal }));
              throw new ProfileSaveError('A newer profile exists. Review before saving.', 409, latest);
            }
            throw e;
          }
          if (ack.ownerId !== item.ownerId) throw new ProfileSaveError('Account changed. Unlock again.', 401);
          const head = responseSchema.parse(await item.api('/api/profile', { signal: requestSignal }));
          if (head.revision > ack.revision) {
            throw new ProfileSaveError('The retried save is older than the current profile. Review before saving.', 409, head);
          }
          return ack;
        }, changed);
        const found: Recovery[] = [];
        if (key && cryptoKey) {
          try {
            item.vault = new DraftVault(localStorage, item.ownerId, PROFILE_SCHEMA_VERSION, key.keyVersion, cryptoKey);
            for (const slot of item.vault.slots()) {
              try {
                const snapshot = draftSnapshot(await item.vault.read(slot));
                if (snapshot.pending || JSON.stringify(snapshot.desired) !== JSON.stringify(snapshot.acknowledged)) found.push({ slot, snapshot });
              } catch { setDraftError('A saved draft could not be unlocked. Its key may have rotated; the encrypted copy is unchanged.'); }
            }
          } catch { setDraftError('Browser storage is unavailable. Keep this tab open until saved.'); }
        }
        if (!alive || signal.aborted) { item.writer.dispose(); item.vault?.dispose(); abort.abort(); return; }
        current.current = item;
        setSession(item);
        setRecoveries(found);
        setLocked(false);
      } catch (e) {
        if (alive && !signal.aborted) lock(e instanceof ProfileSaveError ? e.message : 'Could not unlock the profile. Check your connection and retry.');
      } finally {
        if (alive && !signal.aborted) setChecking(false);
      }
    }
    unlockRef.current = () => { void unlock(); };
    void unlock();
    const focus = () => { if (document.visibilityState === 'visible') void unlock(); };
    const visibility = () => {
      if (document.visibilityState === 'hidden') {
        setLocked(true);
        current.current?.writer.pause();
      } else void unlock();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (current.current?.writer.dirty || current.current?.vault?.pending) { event.preventDefault(); event.returnValue = ''; }
    };
    const navigation = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!link || link.target === '_blank' || link.download || event.metaKey || event.ctrlKey) return;
      const destination = new URL(link.href);
      if (destination.pathname === '/profile') return;
      if (current.current?.writer.dirty || current.current?.vault?.pending) {
        event.preventDefault();
        event.stopPropagation();
        setDraftError('Changes are still pending. Save before leaving this page.');
      }
    };
    window.addEventListener('focus', focus);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', navigation, true);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive = false;
      check?.abort();
      const old = current.current;
      current.current = null;
      old?.abort.abort();
      if (old?.vault) {
        const vault = old.vault;
        // Best effort on SPA unmount only; true principal changes dispose immediately above.
        void vault.save(old.writer.snapshot()).catch(() => {}).finally(() => vault.dispose());
      }
      old?.writer.dispose();
      window.removeEventListener('focus', focus);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', navigation, true);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const writer = session?.writer;
  const snapshot = writer?.snapshot();
  const profile = snapshot?.desired;
  const parsed = profile && ProfileSchema.safeParse(profile);
  const issues: FieldIssues = parsed && !parsed.success ? Object.fromEntries(parsed.error.issues.map((issue) => [issue.path.join('.'), issue.message])) : {};
  const conflict = writer?.error?.status === 409 ? writer.error.current as ProfileResponse | undefined : undefined;
  function retry() {
    if (!writer || !profile || !ProfileSchema.safeParse(profile).success) return;
    writer.retry();
    void writer.flush();
  }
  async function recover(recovery: Recovery) {
    if (!session) return;
    // Keep the failed original request ID; resending it is the only safe way to resolve an uncertain acknowledgement.
    const saved = recovery.snapshot;
    const currentResponse = responseSchema.parse(await session.api('/api/profile'));
    session.writer.reconcile({ revision: saved.revision, profile: saved.acknowledged }, false);
    session.writer.setDesired(saved.desired);
    if (saved.pending) {
      session.writer.restorePending(saved.pending);
      session.writer.retry();
    } else if (currentResponse.revision !== saved.revision) {
      session.writer.pause(new ProfileSaveError('Recovered draft has an older base. Review before saving.', 409, currentResponse));
    }
    if (session.vault && await session.vault.save(session.writer.snapshot())) {
      await session.vault.retire(recovery.slot, recovery.snapshot).catch(() => {});
    }
    setRecoveries([]);
  }
  return <>
    <div className={styles.toolbar}><h1 className={styles.title}>Applicant profile</h1>
      <Link href="/workers" prefetch={false}>Workers</Link>
      {!locked && writer && <p role="status" aria-live="polite" className={styles.muted}>
        {writer.status === 'saved' ? `Saved / revision ${snapshot?.revision}` : writer.status === 'saving' ? 'Saving...' :
          writer.status === 'conflict' ? 'Conflict / review required' : writer.status === 'paused' ? 'Saving paused' : 'Changes pending'}
        {session?.vault?.pending ? ' / Encrypting draft...' : ''}
      </p>}
      {!locked && <button className={styles.button} type="button" onClick={retry} disabled={!!Object.keys(issues).length || writer?.status === 'conflict'}>Retry save</button>}
    </div>
    {locked && <section className={styles.alert}>
      <p role={checking ? 'status' : 'alert'}>{checking ? 'Checking applicant session...' : error || 'Profile locked.'}</p>
      <div className={styles.row}><Link href="/sign-in" prefetch={false} target="_blank" rel="noopener noreferrer">Sign in</Link>
        <button className={styles.button} type="button" disabled={checking} onClick={() => unlockRef.current()}>Unlock profile</button></div>
    </section>}
    {session && profile && <div hidden={locked} key={session.ownerId}>
      {draftError && <p className={styles.alert} role="alert">{draftError}</p>}
      {writer?.error && !conflict && <p className={styles.alert} role="alert">{writer.error.message}</p>}
      {recoveries.length > 0 && <section className={styles.alert} aria-label="Encrypted draft recovery">
        <h2 className={styles.title}>Unsaved drafts</h2>
        {recoveries.map((recovery, i) => <div className={styles.row} key={recovery.slot}>
          <span>Draft {i + 1} / base revision {recovery.snapshot.revision}</span>
          <button className={styles.button} onClick={() => { void recover(recovery).catch(() => setDraftError('Could not recover draft. Unlock and retry.')); }}>Recover draft {i + 1}</button>
        </div>)}
      </section>}
      {conflict && <section className={styles.alert} aria-label="Profile conflict">
        <h2 className={styles.title}>Review revision {conflict.revision}</h2>
        <p>Your draft is still editable below.</p>
        <dl>{differences(profile, conflict.profile).map((change) => <div key={change.path}>
          <dt>{change.path}</dt><dd>Draft: {change.mine}</dd><dd>Server: {change.server}</dd>
        </div>)}</dl>
        <div className={styles.row}>
          <button className={styles.button} disabled={!!Object.keys(issues).length}
            onClick={() => { writer?.reconcile(conflict, true); void writer?.flush(); }}>Save reviewed draft</button>
          <button className={styles.button} onClick={() => writer?.reconcile(conflict, false)}>Use server profile</button>
        </div>
      </section>}
      <div className={styles.layout}>
        <nav className={styles.navigation} aria-label="Profile sections">
          {sections.map((key) => {
            const count = completion(profile[key]);
            return <a key={key} href={`#${key}`}>{PROFILE_SECTION_LABELS[key]}<span className={styles.muted}>{count.answered}/{count.total}</span></a>;
          })}
          <a href="#auto-apply-policy">Auto Apply policy</a>
        </nav>
        <div>
          {sections.map((key) => <section className={styles.section} id={key} key={key} aria-labelledby={`${key}-heading`}>
            <h2 id={`${key}-heading`}>{PROFILE_SECTION_LABELS[key]}</h2>
            {key === 'documentsProvider' && <>
              <DocumentsPane api={session.api} ownerId={session.ownerId} signal={session.abort.signal} onDocuments={setDocuments} />
              <p className={styles.muted}>Provider connection is checked by the paired worker. Keys stay in its OS keychain.</p>
            </>}
            <SectionFields meta={metadata.properties![key]} value={profile[key]} path={[key]} issues={issues} documents={documents}
              onChange={(value) => {
                writer?.setDesired({ ...profile, [key]: value });
                if (writer?.error?.status === 400 && ProfileSchema.safeParse({ ...profile, [key]: value }).success) writer.retry();
              }} />
          </section>)}
          <PolicyPane api={session.api} profileSaved={writer?.status === 'saved'} />
        </div>
      </div>
    </div>}
  </>;
}
