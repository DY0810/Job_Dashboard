import { describe, expect, it } from 'vitest';
import { createEmptyProfile } from './profile.ts';
import { importResumeCandidates } from './resume-import.ts';

const source = { documentId: crypto.randomUUID(), version: 1 };
const extraction = { source, phone: '(123) 456-7890', education: {
  school: 'Example University', level: 'bachelor', degree: 'B.S. Physics/Computer Science', major: 'Physics/Computer Science', expectedGraduation: '2028-12',
}, employment: [{ employer: 'Example', role: 'Engineer', start: '2026-04', achievements: ['Built a service.'] }],
skills: ['TypeScript'] };

describe('resume candidate import', () => {
  it('adds only document-backed candidates and never confirms legal answers', () => {
    const profile = createEmptyProfile();
    const imported = importResumeCandidates(profile, extraction);
    expect(imported.education.schools[0].expectedGraduation).toMatchObject({ state: 'candidate', value: { precision: 'month', value: '2028-12' },
      provenance: { source: 'document', sourceId: source.documentId, sourceVersion: 1 } });
    expect(imported.work.employment[0].achievements[0].statement.state).toBe('candidate');
    expect(imported.identity.phones[0].number.state).toBe('candidate');
    expect(imported.authorization.countries).toEqual([]);
    expect(importResumeCandidates(imported, extraction)).toEqual(imported);
  });

  it('does not overwrite a confirmed fact', () => {
    const profile = createEmptyProfile();
    profile.identity.github = { ...profile.identity.github, state: 'confirmed', value: 'https://github.com/existing', confirmedAt: new Date().toISOString() };
    expect(importResumeCandidates(profile, { ...extraction, github: 'https://github.com/other' }).identity.github.value).toBe('https://github.com/existing');
  });
});
