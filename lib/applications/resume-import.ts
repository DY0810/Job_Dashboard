import { z } from 'zod';
import { AchievementSchema, EducationSchema, EmploymentSchema, ProfileSchema, ProfileSections, ProjectSchema, type Profile } from './profile.ts';

const month = z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/);
export const ResumeImportSchema = z.strictObject({
  source: z.strictObject({ documentId: z.uuid(), version: z.number().int().positive() }),
  phone: z.string().regex(/^[0-9 ()-]{3,30}$/).optional(),
  linkedin: z.url({ protocol: /^https?$/ }).optional(), github: z.url({ protocol: /^https?$/ }).optional(),
  portfolio: z.url({ protocol: /^https?$/ }).optional(),
  education: z.strictObject({ school: z.string().min(1), level: z.enum(['high_school', 'certificate', 'associate', 'bachelor', 'master', 'doctorate', 'other']), degree: z.string().min(1), major: z.string().min(1),
    expectedGraduation: month, gpa: z.strictObject({ value: z.number(), scale: z.number().positive() }).optional() }).optional(),
  employment: z.array(z.strictObject({ employer: z.string().min(1), role: z.string().min(1),
    start: month, end: month.optional(), location: z.string().optional(), achievements: z.array(z.string().min(1).max(4000)).max(20).default([]) })).max(20).default([]),
  projects: z.array(z.strictObject({ name: z.string().min(1), link: z.url({ protocol: /^https?$/ }).optional(),
    achievements: z.array(z.string().min(1).max(4000)).max(20).default([]) })).max(20).default([]),
  skills: z.array(z.string().min(1).max(300)).max(100).default([]),
});
export type ResumeImport = z.infer<typeof ResumeImportSchema>;

export function importResumeCandidates(current: Profile, input: unknown): Profile {
  const data = ResumeImportSchema.parse(input), next = structuredClone(current);
  const candidate = <T extends { state: string; value: unknown; provenance: unknown; confirmedAt: string | null }>(fact: T, value: unknown, excerpt: string): T => ({
    ...fact, state: 'candidate', value, confirmedAt: null,
    provenance: { source: 'document', sourceId: data.source.documentId, sourceVersion: data.source.version, excerpt },
  });
  const achievements = (items: string[]) => items.map(statement => {
    const item = AchievementSchema.parse({});
    item.statement = candidate(item.statement, statement, statement.slice(0, 1000));
    return item;
  });
  for (const key of ['linkedin', 'github', 'portfolio'] as const) {
    if (data[key] && next.identity[key].state === 'unknown') next.identity[key] = candidate(next.identity[key], data[key], data[key]);
  }
  if (data.phone && !next.identity.phones.some(phone => phone.number.value === data.phone)) {
    const phone = ProfileSections.identity.parse({ phones: [{}] }).phones[0];
    phone.number = candidate(phone.number, data.phone, data.phone);
    next.identity.phones.push(phone);
  }
  if (data.education && !next.education.schools.some(school => school.school.value?.toLowerCase() === data.education!.school.toLowerCase())) {
    const school = EducationSchema.parse({});
    school.school = candidate(school.school, data.education.school, data.education.school);
    school.degree = candidate(school.degree, data.education.degree, data.education.degree);
    school.level = candidate(school.level, data.education.level, data.education.degree);
    school.major = candidate(school.major, data.education.major, data.education.major);
    school.expectedGraduation = candidate(school.expectedGraduation, { precision: 'month', value: data.education.expectedGraduation }, data.education.expectedGraduation);
    if (data.education.gpa) school.gpa = candidate(school.gpa, data.education.gpa, `${data.education.gpa.value}/${data.education.gpa.scale}`);
    next.education.schools.push(school);
  }
  for (const item of data.employment) {
    if (next.work.employment.some(job => job.employer.value?.toLowerCase() === item.employer.toLowerCase() && job.role.value?.toLowerCase() === item.role.toLowerCase())) continue;
    const job = EmploymentSchema.parse({});
    job.employer = candidate(job.employer, item.employer, item.employer);
    job.role = candidate(job.role, item.role, item.role);
    job.start = candidate(job.start, { precision: 'month', value: item.start }, item.start);
    if (item.end) job.end = candidate(job.end, { precision: 'month', value: item.end }, item.end);
    else job.current = candidate(job.current, true, 'Present');
    if (item.location) job.location = candidate(job.location, item.location, item.location);
    job.achievements = achievements(item.achievements);
    next.work.employment.push(job);
  }
  for (const item of data.projects) {
    if (next.work.projects.some(project => project.name.value?.toLowerCase() === item.name.toLowerCase())) continue;
    const project = ProjectSchema.parse({});
    project.name = candidate(project.name, item.name, item.name);
    if (item.link) project.link = candidate(project.link, item.link, item.link);
    project.achievements = achievements(item.achievements);
    next.work.projects.push(project);
  }
  for (const name of data.skills) {
    if (next.work.skills.some(skill => skill.name.value?.toLowerCase() === name.toLowerCase())) continue;
    const skill = ProfileSections.work.parse({ skills: [{}] }).skills[0];
    skill.name = candidate(skill.name, name, name);
    next.work.skills.push(skill);
  }
  return ProfileSchema.parse(next);
}
