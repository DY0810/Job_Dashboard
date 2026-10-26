'use client';

import { useEffect, useState } from 'react';
import { ChevronsUpDown } from 'lucide-react';

type Applicant = { ownerId: string; email: string; name: string; active: boolean };

/** Two letters for the avatar: first and last word of a name, or the start of an email. */
const initials = (name: string) => {
  const words = name.split('@')[0].split(/[\s._-]+/).filter(Boolean);
  return ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : words[0]?.[1] ?? '')).toUpperCase();
};

/** A shape check, not Zod: this is in the header on every page, and zod/mini alone was ~17 kB gzipped there. */
function applicantsOf(body: unknown): Applicant[] {
  const list = (body as { applicants?: unknown } | null)?.applicants;
  if (!Array.isArray(list) || !list.every((item: Partial<Applicant> | null) => typeof item?.ownerId === 'string'
    && typeof item.email === 'string' && typeof item.name === 'string' && typeof item.active === 'boolean')) {
    throw new Error('Unexpected applicants response');
  }
  return list;
}

export function ApplicantSwitcher() {
  const [applicants, setApplicants] = useState<Applicant[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/applicants', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? applicantsOf(await response.json()) : [])
      .then((value) => { if (!controller.signal.aborted) setApplicants(value); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load applicant profiles.'); });
    return () => controller.abort();
  }, []);
  const active = applicants.find((applicant) => applicant.active);
  if (!active) return null;
  async function select(ownerId: string) {
    if (ownerId === active?.ownerId) return;
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/applicants', {
        method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerId }),
      });
      if (!response.ok) throw new Error();
      window.location.reload();
    } catch { setError('Could not switch applicant profile.'); setBusy(false); }
  }
  const name = active.name || active.email;
  // Postie's profile button: avatar, name, caret. The native select lies over it, so picking
  // an applicant is still the platform's own menu, keyboard and screen reader included.
  return <>
    <label className="me" title={name}>
      <span className="av me-av" aria-hidden="true">{initials(name)}</span>
      <span className="me-name">{name}</span>
      <span className="me-caret"><ChevronsUpDown size={16} strokeWidth={1.75} aria-hidden="true" /></span>
      <select className="me-select" aria-label="Applicant profile" value={active.ownerId} disabled={busy}
        onChange={(event) => void select(event.target.value)}>
        {applicants.map((applicant) => <option value={applicant.ownerId} key={applicant.ownerId}>
          {applicant.name || applicant.email}
        </option>)}
      </select>
    </label>
    {error && <span role="alert" className="side-error">{error}</span>}
  </>;
}
