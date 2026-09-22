'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { z } from 'zod';

const responseSchema = z.object({ applicants: z.array(z.object({
  ownerId: z.string(), email: z.email(), name: z.string(), active: z.boolean(),
})) });

export function ApplicantSwitcher() {
  const [applicants, setApplicants] = useState<z.infer<typeof responseSchema>['applicants']>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/auth/applicants', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => response.ok ? responseSchema.parse(await response.json()).applicants : [])
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
  return <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
    <label className="flex min-w-0 items-center gap-2">
      <span>Applicant</span>
      <select className="note-input min-w-0 max-w-64" aria-label="Applicant profile" value={active.ownerId} disabled={busy}
        onChange={(event) => void select(event.target.value)}>
        {applicants.map((applicant) => <option value={applicant.ownerId} key={applicant.ownerId}>
          {applicant.name || applicant.email} ({applicant.email})
        </option>)}
      </select>
    </label>
    <Link href="/sign-in?add=1" prefetch={false}>Add applicant</Link>
    {error && <span role="alert">{error}</span>}
  </div>;
}
