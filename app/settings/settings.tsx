'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { PolicySchema } from '../../lib/applications/policy';
import { WorkerListSchema } from '../../lib/applications/worker-protocol';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});

async function request(path: string, ownerId?: string) {
  const headers = new Headers();
  if (ownerId) headers.set(EXPECTED_APPLICANT_HEADER, ownerId);
  const response = await fetch(path, { headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? 'Unlock Workie to view private settings.' : 'Private settings are unavailable.');
  return body;
}

const display = (value: string) => value.replaceAll('_', ' ');
const list = (values: string[]) => values.length ? values.join(', ') : 'None configured';

export default function Settings() {
  const [account, setAccount] = useState<z.infer<typeof ApplicantSchema> | null>(null);
  const [policy, setPolicy] = useState<z.infer<typeof PolicyResponseSchema> | null>(null);
  const [workers, setWorkers] = useState<z.infer<typeof WorkerListSchema> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const nextAccount = ApplicantSchema.parse(await request('/api/auth/applicant'));
      const [nextPolicy, nextWorkers] = await Promise.all([
        PolicyResponseSchema.parse(await request('/api/auto-apply/policies', nextAccount.ownerId)),
        WorkerListSchema.parse(await request('/api/workers', nextAccount.ownerId)),
      ]);
      if (nextWorkers.ownerId !== nextAccount.ownerId) throw new Error('Account changed. Refresh the current applicant.');
      setAccount(nextAccount); setPolicy(nextPolicy); setWorkers(nextWorkers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Private settings are unavailable.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading) return <p className={styles.message} role="status">Loading private settings...</p>;
  if (error) return <div><p className={styles.message} role="alert">{error}</p><Link href="/sign-in" prefetch={false}>Sign in</Link></div>;
  if (!account || !policy || !workers) return null;

  const configured = policy.policy.allowedProviders.length > 0;
  const online = workers.workers.filter((worker) => worker.online && worker.revokedAt === null);
  return <>
    <div className={styles.toolbar}>
      <h1>Settings</h1><span className={styles.muted}>{account.email}</span>
      <button className={styles.button} type="button" onClick={() => void load()}>Refresh</button>
    </div>
    <p className={styles.muted}>Execution stays disabled until the saved policy, paired worker, documents and provider checks all agree.</p>
    <section className={styles.section} aria-labelledby="provider-heading">
      <h2 id="provider-heading">Provider</h2>
    <div className={styles.row}><strong>{configured ? 'Provider policy configured' : 'No provider selected'}</strong><span>{display(policy.policy.privacy)}</span></div>
    <p className={styles.muted}>Provider keys are read only by the paired worker from its OS keychain. This page never reads, stores or displays them.</p>
      <p><Link href="/profile" prefetch={false}>Edit provider and policy in Profile</Link></p>
    </section>
    <section className={styles.section} aria-labelledby="budget-heading">
      <h2 id="budget-heading">Budget</h2>
      <div className={styles.row}>
        <span>Per request: {policy.policy.budget.currency} {policy.policy.budget.perRequest}</span>
        <span>Per run: {policy.policy.budget.currency} {policy.policy.budget.perRun}</span>
        <span>Per day: {policy.policy.budget.currency} {policy.policy.budget.perDay}</span>
      </div>
      <p className={styles.muted}>Jev has a hard cumulative worker ledger cap of USD 10. Current spend is local to the worker and is not exposed to the browser.</p>
    </section>
    <section className={styles.section} aria-labelledby="runner-heading">
      <h2 id="runner-heading">Runner</h2>
      <div className={styles.row}><span>{online.length ? `${online.length} worker${online.length === 1 ? '' : 's'} online` : 'No worker online'}</span><span>{policy.runnerAvailable ? 'Available' : 'Offline'}</span></div>
      <p className={styles.muted}>The runner is a separate local process. Closing this page does not stop it; sleeping the host does.</p>
      <p><Link href="/workers" prefetch={false}>Pair, start or revoke workers</Link></p>
    </section>
    <section className={styles.section} aria-labelledby="privacy-heading">
      <h2 id="privacy-heading">Privacy and account policy</h2>
      <div className={styles.row}><span>Remote consent: {policy.policy.remoteProviderConsent ? 'on' : 'off'}</span><span>Fallback: {list(policy.policy.fallbackOrder)}</span><span>New accounts: {display(policy.policy.accountPolicy)}</span></div>
      <p className={styles.muted}>Confirmed facts and approved documents are the only values eligible for form filling. Unknown required questions pause only the affected application in the private inbox.</p>
    </section>
    <section className={styles.section} aria-labelledby="support-heading">
      <h2 id="support-heading">Support and recovery</h2>
      <p><Link href="/applications" prefetch={false}>View application history</Link> / <Link href="/inbox" prefetch={false}>Open answer inbox</Link></p>
      <p className={styles.muted}>Receipt evidence is required for a sent status. A timeout or missing confirmation remains submission unknown and is never retried blindly.</p>
    </section>
  </>;
}
