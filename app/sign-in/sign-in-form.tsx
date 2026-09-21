'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient } from '@/lib/auth-client';
import type { Applicant } from '@/lib/applicant-access';
import styles from './sign-in-form.module.css';

type Mode = 'sign-in' | 'sign-up' | 'forgot' | 'verify' | 'reset';
const titles: Record<Mode, string> = {
  'sign-in': 'Sign in',
  'sign-up': 'Create account',
  forgot: 'Reset password',
  verify: 'Resend verification',
  reset: 'Set new password',
};
const emailNotice = 'If this address is eligible, check your email to continue.';

export function SignInForm() {
  const params = useSearchParams();
  const requestedMode = params.get('mode');
  const mode: Mode = requestedMode && Object.hasOwn(titles, requestedMode) ? requestedMode as Mode : 'sign-in';
  return <AuthForm key={mode} mode={mode} />;
}

function AuthForm({ mode }: { mode: Mode }) {
  const params = useSearchParams();
  const resetToken = params.get('token') ?? '';
  const [applicant, setApplicant] = useState<Applicant | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const passwordMode = ['sign-in', 'sign-up', 'reset'].includes(mode);
  const showAccount = applicant && mode !== 'reset';

  useEffect(() => {
    setBusy(false);
    // Token changes invalidate pending work without remounting away a success notice.
    return () => { generation.current += 1; };
  }, [resetToken]);

  function beginRequest() {
    const request = ++generation.current;
    // Check the live URL too, before React has committed navigation/cleanup.
    return () => {
      const url = new URL(window.location.href);
      const requested = url.searchParams.get('mode') ?? '';
      const currentMode = Object.hasOwn(titles, requested) ? requested : 'sign-in';
      return generation.current === request && url.pathname === '/sign-in' &&
        currentMode === mode && (url.searchParams.get('token') ?? '') === resetToken;
    };
  }

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/applicant', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const account = response.ok ? await response.json() : null;
        if (controller.signal.aborted) return;
        if (response.ok) setApplicant(account);
        else if (response.status === 503) setError('Applicant authentication is unavailable.');
        else if (response.status === 403) setError('Applicant access is not permitted.');
      })
      .catch(() => { if (!controller.signal.aborted) setError('Could not check your session.'); })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const email = String(data.get('email') ?? '').trim();
    const password = String(data.get('password') ?? '');
    setError('');
    setNotice('');
    if ((mode === 'sign-up' || mode === 'reset') && password !== data.get('confirmation')) {
      setError('Passwords do not match.');
      return;
    }
    if (mode === 'reset' && !resetToken) {
      setError('This reset link is invalid or expired. Request another link.');
      return;
    }
    const isCurrent = beginRequest();
    setBusy(true);
    try {
      const result = mode === 'sign-in'
        ? await authClient.signIn.email({ email, password })
        : mode === 'sign-up'
          ? await authClient.signUp.email({ email, password, name: String(data.get('name') ?? '').trim(), callbackURL: '/sign-in' })
          : mode === 'forgot'
            ? await authClient.requestPasswordReset({ email, redirectTo: '/sign-in?mode=reset' })
            : mode === 'verify'
              ? await authClient.sendVerificationEmail({ email, callbackURL: '/sign-in' })
              : await authClient.resetPassword({ newPassword: password, token: resetToken });
      if (!isCurrent()) return;
      if (result.error) {
        setError(result.error.status === 503
          ? 'Applicant authentication is unavailable.'
          : result.error.status === 429
            ? 'Too many attempts. Try again shortly.'
            : mode === 'sign-in'
              ? 'Sign-in failed. Check your credentials and verify your email.'
              : mode === 'reset'
                ? 'This reset link is invalid or expired. Request another link.'
                : 'Request failed. Check the fields and try again.');
        return;
      }
      form.reset();
      if (mode === 'sign-in') {
        const response = await fetch('/api/auth/applicant', { cache: 'no-store' });
        if (!response.ok) throw new Error('Session unavailable');
        const account = await response.json();
        if (!isCurrent()) return;
        setApplicant(account);
      } else {
        setNotice(mode === 'reset' ? 'Password updated. Sign in with your new password.' : emailNotice);
        if (mode === 'reset') {
          setApplicant(null);
          setBusy(false);
          // The no-referrer page keeps an unused link reloadable until success.
          // Finish state updates before our own URL change invalidates isCurrent.
          const url = new URL(window.location.href);
          if (url.pathname === '/sign-in' && url.searchParams.get('mode') === 'reset' &&
              url.searchParams.get('token') === resetToken) {
            url.searchParams.delete('token');
            window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
          }
        }
      }
    } catch {
      if (isCurrent()) setError('Request could not be completed. Try again.');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  async function signOut() {
    const isCurrent = beginRequest();
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (!isCurrent()) return;
      if (result.error) throw new Error('Sign-out failed');
      setApplicant(null);
      setNotice('Signed out.');
    } catch {
      if (isCurrent()) setError('Could not sign out. Try again.');
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  const linkError = params.has('error') ? 'This link is invalid or expired. Request another link.' : '';
  return (
    <div className={`${styles.form} min-w-0 text-sm`}>
      <h1 className="mb-6 text-lg font-medium">{showAccount ? 'Account' : titles[mode]}</h1>
      {checking ? <p role="status">Checking session...</p> : showAccount ? (
        <div className="grid gap-4">
          <p className="break-words">{applicant.email}</p>
          <div className="flex flex-wrap gap-3">
            <Link href="/" className="chip">Jobs</Link>
            <button className="chip" type="button" disabled={busy} onClick={signOut}>Sign out</button>
          </div>
        </div>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={busy} className="grid min-w-0 gap-5 border-0 p-0">
            {mode === 'sign-up' && (
              <label className="grid min-w-0 gap-1" htmlFor="auth-name">
                Name
                <input id="auth-name" className="note-input w-full min-w-0" name="name" autoComplete="name" required maxLength={120} />
              </label>
            )}
            {mode !== 'reset' && (
              <label className="grid min-w-0 gap-1" htmlFor="auth-email">
                Email
                <input id="auth-email" className="note-input w-full min-w-0" name="email" type="email" autoComplete="email" required maxLength={320} />
              </label>
            )}
            {passwordMode && (
              <label className="grid min-w-0 gap-1" htmlFor="auth-password">
                {mode === 'reset' ? 'New password' : 'Password'}
                <input id="auth-password" className="note-input w-full min-w-0" name="password" type="password" autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'} required minLength={12} maxLength={128} />
              </label>
            )}
            {(mode === 'sign-up' || mode === 'reset') && (
              <label className="grid min-w-0 gap-1" htmlFor="auth-confirmation">
                Confirm password
                <input id="auth-confirmation" className="note-input w-full min-w-0" name="confirmation" type="password" autoComplete="new-password" required minLength={12} maxLength={128} />
              </label>
            )}
            <button className="chip justify-self-start" type="submit">{busy ? 'Working...' : titles[mode]}</button>
          </fieldset>
        </form>
      )}
      {(error || linkError) && <p role="alert" className="mt-4 break-words">{error || linkError}</p>}
      {notice && !error && !linkError && <p role="status" className="mt-4 break-words">{notice}</p>}
      {!showAccount && !checking && (
        <nav aria-label="Sign-in options" className="mt-6 flex flex-wrap gap-x-4 gap-y-3 border-t border-rule pt-4 text-xs">
          <Link href="/sign-in">Sign in</Link>
          <Link href="/sign-in?mode=sign-up">Create account</Link>
          <Link href="/sign-in?mode=forgot">Forgot password?</Link>
          <Link href="/sign-in?mode=verify">Resend verification</Link>
        </nav>
      )}
    </div>
  );
}
