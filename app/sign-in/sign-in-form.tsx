'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import type { Applicant } from '@/lib/applicant-access';
import styles from './sign-in-form.module.css';
import { ApplicantSwitcher } from '../applicant-switcher';

export function SignInForm() {
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/household', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (response.ok) setApplicant(await response.json());
        else if (response.status >= 500) setError('Household access is unavailable.');
      })
      .catch(() => { if (!controller.signal.aborted) setError('Could not check household access.'); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/household', {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passcode: String(data.get('passcode') ?? ''), profile: String(data.get('profile') ?? 'dy') }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(typeof body.error === 'string' ? body.error : 'Could not unlock Workie.');
      }
      setApplicant(await response.json());
      window.location.assign('/');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not unlock Workie.');
      setBusy(false);
    }
  }

  async function lock() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/household', { method: 'DELETE', cache: 'no-store' });
      if (!response.ok) throw new Error();
      setApplicant(null);
    } catch { setError('Could not lock Workie.'); }
    finally { setBusy(false); }
  }

  return (
    <div className={`${styles.form} auth min-w-0`}>
      <h1>Household access</h1>
      {checking ? <p role="status" className="muted">Checking access…</p> : applicant ? (
        <div className="mt-3 grid gap-4">
          <p className="muted">{applicant.name} is active.</p>
          <div className="flex rounded-[var(--r)] border border-rule"><ApplicantSwitcher /></div>
          <div className="flex flex-wrap gap-2">
            <Link href="/" className="btn">Jobs</Link>
            <Link href="/profile" prefetch={false} className="btn">Profile</Link>
            <Link href="/applications?settings=1" prefetch={false} className="btn">Settings</Link>
            <button className="btn danger" type="button" disabled={busy} onClick={lock}>Lock</button>
          </div>
        </div>
      ) : (
        <form onSubmit={unlock}>
          <p className="muted">Unlock to see your profile and Auto Apply.</p>
          <fieldset disabled={busy} className="mt-3 grid min-w-0 gap-3.5 border-0 p-0">
            <label className="grid min-w-0 gap-1.5" htmlFor="household-profile">
              <span className="label">Applicant</span>
              <select id="household-profile" className="auth-input w-full min-w-0" name="profile" defaultValue="dy">
                <option value="dy">DY</option>
                <option value="may">May</option>
              </select>
            </label>
            <label className="grid min-w-0 gap-1.5" htmlFor="household-passcode">
              <span className="label">Passcode</span>
              <input id="household-passcode" className="auth-input w-full min-w-0" name="passcode" type="password"
                inputMode="numeric" autoComplete="current-password" pattern="[0-9]{4,12}" minLength={4} maxLength={12} required placeholder="Numeric code…" spellCheck={false} />
            </label>
            <button className="btn primary" type="submit">{busy ? 'Unlocking…' : 'Unlock Workie'}</button>
          </fieldset>
        </form>
      )}
      {error && <p role="alert" className="warn mt-2 break-words">{error}</p>}
    </div>
  );
}
