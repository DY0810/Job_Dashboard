import { z } from 'zod';

export const PROFILE_SCHEMA_VERSION = 1 as const;
export const FACT_STATES = ['unknown', 'declined', 'not_applicable', 'candidate', 'confirmed'] as const;
const id = z.uuid();
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const short = z.string().trim().min(1).max(300);
const prose = z.string().trim().min(1).max(4000);
const country = z.string().regex(/^[A-Z]{2}$/);
const url = z.url({ protocol: /^https?$/ }).max(2048);
const strings = z.array(short).max(100);
export const PreciseDateSchema = z.discriminatedUnion('precision', [
  z.strictObject({ precision: z.literal('year'), value: z.string().regex(/^(19|20|21)\d{2}$/) }),
  z.strictObject({ precision: z.literal('month'), value: z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/) }),
  z.strictObject({ precision: z.literal('day'), value: z.iso.date().refine((s) => /^(19|20|21)/.test(s)) }),
]);
type PreciseDate = z.infer<typeof PreciseDateSchema>;
function dateBounds(date: PreciseDate): [string, string] {
  if (date.precision === 'year') return [`${date.value}-01-01`, `${date.value}-12-31`];
  if (date.precision === 'month') return [`${date.value}-01`, `${date.value}-31`];
  return [date.value, date.value];
}
function datesReversed(start: PreciseDate | null, end: PreciseDate | null) {
  return start !== null && end !== null && dateBounds(start)[0] > dateBounds(end)[1];
}
export const FactScopeSchema = z.strictObject({
  kind: z.enum(['applicant', 'country', 'employer', 'application']),
  country: country.nullable(),
  employer: short.nullable(),
  applicationId: id.nullable(),
  includesSubsidiaries: z.boolean(),
  timeframe: z.enum(['current', 'historical', 'future', 'ever']),
  validFrom: PreciseDateSchema.nullable(),
  validUntil: PreciseDateSchema.nullable(),
}).superRefine((s, ctx) => {
  if ((s.kind === 'country' && !s.country) || (s.kind === 'employer' && !s.employer) ||
      (s.kind === 'application' && !s.applicationId)) {
    ctx.addIssue({ code: 'custom', message: 'Scope requires its exact destination.' });
  }
  if ((s.kind === 'applicant' && (s.country || s.employer || s.applicationId || s.includesSubsidiaries)) ||
      (s.kind === 'country' && (s.employer || s.applicationId || s.includesSubsidiaries)) ||
      (s.kind === 'employer' && s.applicationId) || datesReversed(s.validFrom, s.validUntil)) {
    ctx.addIssue({ code: 'custom', message: 'Scope or date range is inconsistent.' });
  }
});
export const ProvenanceSchema = z.strictObject({
  source: z.enum(['user', 'document', 'model']),
  sourceId: id.nullable(),
  sourceVersion: version.nullable(),
  excerpt: z.string().max(1000).nullable(),
});
const defaultScope = () => ({
  kind: 'applicant' as const, country: null, employer: null, applicationId: null,
  includesSubsidiaries: false, timeframe: 'current' as const, validFrom: null, validUntil: null,
});

/** Same wrapper everywhere; values remain field-specific, never arbitrary records. */
function fact<T extends z.ZodType, K extends string, U extends string | null>(
  value: T, type: K, units: U, control = 'text',
) {
  return z.strictObject({
    id, version, state: z.enum(FACT_STATES), type: z.literal(type), units: z.literal(units),
    value: value.nullable(),
    scope: FactScopeSchema,
    provenance: ProvenanceSchema,
    confirmedAt: z.iso.datetime().nullable(),
  }).superRefine((f, ctx) => {
    const hasValue = f.state === 'confirmed' || f.state === 'candidate';
    if (hasValue !== ('value' in f && f.value !== null)) {
      ctx.addIssue({ code: 'custom', path: ['value'], message: 'Only confirmed or candidate facts carry values.' });
    }
    if ((f.state === 'confirmed') !== (f.confirmedAt !== null)) {
      ctx.addIssue({ code: 'custom', path: ['confirmedAt'], message: 'Confirmation time must match confirmed state.' });
    }
    if (f.provenance.source !== 'user' && (!f.provenance.sourceId || !f.provenance.sourceVersion)) {
      ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'Imported candidates require a versioned source.' });
    }
  }).meta({ fact: true, control, factType: type, units }).default(() => ({
    id: crypto.randomUUID(), version: 1, state: 'unknown', type, units, value: null,
    scope: defaultScope(), provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: null },
    confirmedAt: null,
  }) as never);
}
const text = () => fact(short, 'text', null);
const longText = () => fact(prose, 'text', null, 'textarea');
const bool = () => fact(z.boolean(), 'boolean', null, 'checkbox');
const list = () => fact(strings, 'text_list', null, 'list');
const date = () => fact(PreciseDateSchema, 'date', null, 'date');
const link = () => fact(url, 'url', null, 'url');
const email = () => fact(z.email().max(254), 'email', null, 'email');
const number = (max: number, units: string, integer = false) =>
  fact(integer ? z.number().int().min(0).max(max) : z.number().min(0).max(max), 'number', units, 'number');
const choice = <T extends readonly [string, ...string[]]>(values: T) => fact(z.enum(values), 'choice', null, 'select');
const entity = { id: id.default(() => crypto.randomUUID()), version: version.default(1) };
const collection = <T extends z.ZodType>(schema: T) => z.array(schema).max(100).default([]);
const address = z.strictObject({
  line1: short, line2: z.string().max(300), city: short, region: z.string().max(100),
  postalCode: z.string().max(32), country,
});
const money = z.strictObject({
  amount: z.number().min(0).max(1_000_000_000), currency: z.string().regex(/^[A-Z]{3}$/),
  period: z.enum(['hour', 'day', 'week', 'month', 'year', 'project']),
});
const docRef = z.strictObject({ documentId: id, version });

export const EducationSchema = z.strictObject({
  ...entity, school: text(), level: choice(['high_school', 'certificate', 'associate', 'bachelor', 'master', 'doctorate', 'other']),
  degree: text(), major: text(), minors: list(), status: choice(['in_progress', 'completed', 'paused', 'withdrawn']),
  enrollmentStart: date(), expectedGraduation: date(), completedAt: date(),
  gpa: fact(z.strictObject({ value: z.number().min(0).max(100), scale: z.number().positive().max(100) })
    .refine((g) => g.value <= g.scale), 'gpa', 'points', 'gpa'),
  standing: text(), completedYears: number(20, 'years'), coursework: list(), honors: list(), memberships: list(),
  transcript: fact(docRef, 'document', null, 'document'),
});
export const AchievementSchema = z.strictObject({
  ...entity, statement: longText(), contribution: choice(['individual', 'shared', 'entire_system']),
  evidence: collection(z.strictObject({
    ...entity, kind: choice(['production', 'local_benchmark', 'controlled_replay', 'synthetic_test', 'estimate', 'source']),
    description: longText(), url: link(), document: fact(docRef, 'document', null, 'document'),
  })),
  metric: fact(z.strictObject({
    value: z.number().min(-1e12).max(1e12), units: short,
    basis: z.enum(['production', 'local_benchmark', 'controlled_replay', 'synthetic_test', 'estimate']),
    comparison: prose,
  }), 'metric', 'specified', 'metric'),
});
export const EmploymentSchema = z.strictObject({
  ...entity, employer: text(), role: text(), start: date(), end: date(), current: bool(),
  location: text(), country: fact(country, 'country', null), achievements: collection(AchievementSchema), link: link(),
});
export const ProjectSchema = z.strictObject({
  ...entity, name: text(), role: text(), start: date(), end: date(), current: bool(),
  achievements: collection(AchievementSchema), link: link(),
});
export const AuthorizationSchema = z.strictObject({
  ...entity, country: fact(country, 'country', null), rightToWork: bool(), citizenship: bool(),
  residenceStatus: text(), sponsorshipNow: bool(), sponsorshipFuture: bool(), exportControlEligible: bool(),
  clearance: text(), validUntil: date(),
});
export const DisclosureSchema = z.strictObject({
  ...entity, employer: text(), includesSubsidiaries: bool(),
  meaning: choice(['prior_employment', 'family_relationship', 'non_compete', 'employment_restriction',
    'confidentiality', 'intellectual_property', 'trade_secrets', 'government', 'procurement', 'conflict']),
  exactQuestion: longText(), timeframe: choice(['current', 'historical', 'ever', 'future']),
  answer: bool(), explanation: longText(),
});
export const ProfileSections = {
  identity: z.strictObject({
    legalFirstName: text(), legalMiddleName: text(), legalLastName: text(), preferredName: text(),
    personalEmail: email(), schoolEmail: email(),
    phones: collection(z.strictObject({
      ...entity, number: fact(z.string().regex(/^[0-9 ()-]{3,30}$/), 'phone', null, 'tel'),
      countryCode: fact(z.string().regex(/^\+[1-9]\d{0,3}$/), 'calling_code', null, 'tel'),
      type: choice(['mobile', 'home', 'work']),
    })),
    currentAddress: fact(address, 'address', null, 'address'),
    permanentAddress: fact(address, 'address', null, 'address'),
    portfolio: link(), github: link(), linkedin: link(), ageEligible: bool(),
  }),
  education: z.strictObject({
    schools: collection(EducationSchema),
    certifications: collection(z.strictObject({ ...entity, name: text(), issuer: text(), earnedAt: date(), expiresAt: date(), credential: link() })),
  }),
  work: z.strictObject({
    employment: collection(EmploymentSchema), projects: collection(ProjectSchema),
    skills: collection(z.strictObject({ ...entity, name: text(), evidenceFactIds: fact(z.array(id).max(100), 'fact_ids', null, 'list') })),
  }),
  authorization: z.strictObject({ countries: collection(AuthorizationSchema) }),
  availability: z.strictObject({
    windows: collection(z.strictObject({ ...entity, term: text(), start: date(), end: date() })),
    hoursDuringClasses: number(168, 'hours_per_week'), hoursDuringBreaks: number(168, 'hours_per_week'),
    classPlan: choice(['continuing', 'leave', 'not_enrolled']), locations: list(), relocationLocations: list(),
    workModes: fact(z.array(z.enum(['remote', 'hybrid', 'onsite'])).max(3), 'work_modes', null, 'multiselect'),
    onsiteDays: number(7, 'days_per_week', true), remoteDays: number(7, 'days_per_week', true),
    travelPercent: number(100, 'percent'), transportation: text(), driversLicense: bool(),
    offers: collection(z.strictObject({ ...entity, employer: text(), deadline: date(), status: choice(['pending', 'accepted', 'declined']) })),
    futureEducation: longText(),
  }),
  disclosures: z.strictObject({ answers: collection(DisclosureSchema) }),
  voluntary: z.strictObject({
    raceEthnicity: list(), gender: text(), pronouns: text(), veteran: text(), disability: text(),
  }),
  preferences: z.strictObject({
    targetRoles: list(), countries: fact(z.array(country).max(100), 'countries', null, 'list'),
    locations: list(), degreeEligibility: list(), termEligibility: list(),
    payFloor: fact(money, 'money', 'currency_per_period', 'money'),
    undisclosedPay: choice(['include', 'exclude', 'ask']), employerBlocklist: list(),
    accountPolicy: choice(['skip_new_accounts', 'existing_only', 'allow_new_with_consent']),
    sourceAnswer: text(),
    contactByContext: collection(z.strictObject({
      ...entity, employer: text(), context: choice(['general', 'school_required', 'specific_application']),
      email: choice(['personal', 'school']),
    })),
    dailyApplicationCap: number(1000, 'applications_per_day', true),
    reapplyAfterDays: number(3650, 'days', true),
  }),
  documentsProvider: z.strictObject({
    masters: collection(z.strictObject({ ...entity, role: text(), document: fact(docRef, 'document', null, 'document') })),
    supportingDocuments: collection(z.strictObject({
      ...entity, kind: choice(['transcript', 'certificate', 'portfolio', 'cover_letter', 'other']),
      document: fact(docRef, 'document', null, 'document'),
    })),
    formatPolicy: choice(['preserve_exact', 'approved_template']),
    provider: choice(['none', 'local', 'omniroute', 'remote', 'typesafe_jev']),
    model: text(), endpoint: link(), allowedFallbackProviders: list(),
    privacy: choice(['local_inference_only', 'fully_local', 'approved_remote']),
    requestBudget: fact(money, 'money', 'currency_per_period', 'money'),
    dailyBudget: fact(money, 'money', 'currency_per_period', 'money'),
  }),
} as const;

export const ProfileSchema = z.strictObject({
  schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
  ...ProfileSections,
}).superRefine((profile, ctx) => {
  const seen = new Set<string>();
  function visit(value: unknown, path: (string | number)[]) {
    if (Array.isArray(value)) { value.forEach((v, i) => visit(v, [...path, i])); return; }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === 'string') {
      if (seen.has(obj.id)) ctx.addIssue({ code: 'custom', path, message: 'Duplicate entity or fact ID.' });
      seen.add(obj.id);
    }
    if ('state' in obj) return;
    for (const [key, child] of Object.entries(obj)) visit(child, [...path, key]);
  }
  visit(profile, []);
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: 'custom', path, message });
  for (const [i, school] of profile.education.schools.entries()) {
    if (school.status.state === 'confirmed' && school.status.value !== 'completed' && school.completedAt.state === 'confirmed') {
      issue(['education', 'schools', i, 'completedAt'], 'An uncompleted credential cannot have a completed date.');
    }
    if (datesReversed(school.enrollmentStart.value, school.expectedGraduation.value) ||
        datesReversed(school.enrollmentStart.value, school.completedAt.value)) {
      issue(['education', 'schools', i], 'Education dates are reversed.');
    }
    if (school.completedAt.state === 'confirmed' && school.completedAt.value &&
        dateBounds(school.completedAt.value)[0] > new Date().toISOString().slice(0, 10)) {
      issue(['education', 'schools', i, 'completedAt'], 'Future graduation is expected, not completed.');
    }
  }
  for (const key of ['employment', 'projects'] as const) {
    for (const [i, item] of profile.work[key].entries()) {
      if (datesReversed(item.start.value, item.end.value)) issue(['work', key, i], 'Work dates are reversed.');
      if (item.current.state === 'confirmed' && item.current.value === true && item.end.state === 'confirmed') {
        issue(['work', key, i, 'end'], 'A current role cannot have an actual end date.');
      }
    }
  }
  for (const [i, item] of profile.authorization.countries.entries()) {
    for (const [key, f] of Object.entries(item)) {
      if (typeof f !== 'object' || !f || !('state' in f) || key === 'country' || f.state !== 'confirmed') continue;
      if (item.country.state !== 'confirmed' || f.scope.kind !== 'country' || f.scope.country !== item.country.value) {
        issue(['authorization', 'countries', i, key, 'scope'], 'Authorization facts require the exact confirmed country scope.');
      }
    }
  }
  for (const [i, item] of profile.disclosures.answers.entries()) {
    if (item.answer.state !== 'confirmed') continue;
    if (item.employer.state !== 'confirmed' || item.exactQuestion.state !== 'confirmed' ||
        item.meaning.state !== 'confirmed' || item.timeframe.state !== 'confirmed' ||
        item.includesSubsidiaries.state !== 'confirmed' || item.answer.scope.kind !== 'employer' ||
        item.answer.scope.employer !== item.employer.value || item.answer.scope.timeframe !== item.timeframe.value ||
        item.answer.scope.includesSubsidiaries !== item.includesSubsidiaries.value) {
      issue(['disclosures', 'answers', i, 'answer', 'scope'], 'Confirm the exact employer, wording, subsidiaries and timeframe before reusing this answer.');
    }
  }
  for (const [i, window] of profile.availability.windows.entries()) {
    if (datesReversed(window.start.value, window.end.value)) issue(['availability', 'windows', i], 'Availability dates are reversed.');
  }
  const { onsiteDays, remoteDays } = profile.availability;
  if (onsiteDays.state === 'confirmed' && remoteDays.state === 'confirmed' &&
      (onsiteDays.value ?? 0) + (remoteDays.value ?? 0) > 7) issue(['availability'], 'Weekly onsite and remote days cannot exceed seven.');
});
export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileSection = keyof typeof ProfileSections;
export const PROFILE_SECTION_LABELS: Record<ProfileSection, string> = {
  identity: 'Identity and contact', education: 'Education', work: 'Work and projects',
  authorization: 'Work authorization', availability: 'Availability', disclosures: 'Employment disclosures',
  voluntary: 'Voluntary answers', preferences: 'Application preferences', documentsProvider: 'Documents and provider',
};
/** JSON Schema properties carry fact/control/factType/units metadata for native controls. */
export const PROFILE_FIELD_METADATA = z.toJSONSchema(ProfileSchema);
export function createEmptyProfile(): Profile {
  return ProfileSchema.parse({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    ...Object.fromEntries(Object.keys(ProfileSections).map((key) => [key, {}])),
  });
}
export const emptyProfile = createEmptyProfile();
function idsWereSupplied(input: unknown, parsed: unknown): boolean {
  if (Array.isArray(parsed)) return Array.isArray(input) && parsed.every((value, i) => idsWereSupplied(input[i], value));
  if (!parsed || typeof parsed !== 'object') return true;
  const output = parsed as Record<string, unknown>;
  const raw = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  if (typeof output.id === 'string' && (raw.id !== output.id || raw.version !== output.version)) return false;
  return Object.entries(output).every(([key, value]) => idsWereSupplied(raw[key], value));
}
const savedProfile = z.unknown().transform((input, ctx) => {
  const parsed = ProfileSchema.safeParse(input);
  if (!parsed.success || !idsWereSupplied(input, parsed.data)) {
    ctx.addIssue({ code: 'custom', message: 'A full valid profile with explicit fact/entity IDs and versions is required.' });
    return z.NEVER;
  }
  return parsed.data;
});
export const ProfileSaveSchema = z.strictObject({
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  requestId: id,
  // Defaults are UI constructors, never a source of new IDs during an HTTP retry.
  profile: savedProfile,
});
export type ProfileSave = z.infer<typeof ProfileSaveSchema>;
export type ProfileResponse = { revision: number; profile: Profile; ownerId: string };

export type ProfileFact = Profile['identity']['legalFirstName'] |
  Profile['identity']['ageEligible'] | Profile['identity']['currentAddress'];

/** Preserve typed sections while excluding candidates from execution. */
export function effectiveProfile(profile: Profile): Profile {
  const copy = structuredClone(ProfileSchema.parse(profile));
  function visit(value: unknown) {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if ('state' in obj) {
      if (obj.state === 'candidate') { obj.state = 'unknown'; obj.value = null; obj.confirmedAt = null; }
      return;
    }
    Object.values(obj).forEach(visit);
  }
  visit(copy);
  return copy;
}

/** Only identity/contact essentials; optional EEO and imported candidates never gate enablement. */
export function profileEnablementIssues(profile: Profile): string[] {
  return (['legalFirstName', 'legalLastName', 'personalEmail'] as const)
    .filter((key) => profile.identity[key].state !== 'confirmed')
    .map((key) => `identity.${key}`);
}
