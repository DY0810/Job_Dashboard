'use client';

import { useEffect, useState } from 'react';
import * as z from 'zod/mini';
import { ChevronRight } from 'lucide-react';

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
  return <>
    <span className="select-box min-w-0">
      <select className="select min-w-0 max-w-48" aria-label="Applicant profile" value={active.ownerId} disabled={busy}
        onChange={(event) => void select(event.target.value)}>
        {applicants.map((applicant) => <option value={applicant.ownerId} key={applicant.ownerId}>
          {applicant.name || applicant.email} ({applicant.email})
        </option>)}
      </select>
      <ChevronRight size={12} strokeWidth={1.25} absoluteStrokeWidth />
    </span>
    {error && <span role="alert" className="text-[11px]">{error}</span>}
  </>;
}
