'use client';

import { z } from 'zod';
import { Close } from '@/app/icons';
import { ProfileSections, type ProfileSection } from '@/lib/applications/profile';
import styles from './profile.module.css';

export type FieldMeta = {
  type?: string; properties?: Record<string, FieldMeta>; items?: FieldMeta;
  enum?: string[]; const?: unknown; anyOf?: FieldMeta[]; oneOf?: FieldMeta[];
  fact?: boolean; control?: string; units?: string | null; format?: string;
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; maxItems?: number;
};
export type Fact = {
  id: string; version: number; state: 'unknown' | 'declined' | 'not_applicable' | 'candidate' | 'confirmed';
  type: string; units: string | null; value: unknown; confirmedAt: string | null;
  scope: Record<string, unknown>; provenance: { source: string; sourceId: string | null; sourceVersion: number | null; excerpt: string | null };
};
export type DocumentOption = { id: string; version: number; name: string; state: string };
export type FieldIssues = Record<string, string>;
const overrides: Record<string, string> = {
  legalFirstName: 'Legal first name', legalMiddleName: 'Legal middle name', legalLastName: 'Legal last name',
  personalEmail: 'Personal email', schoolEmail: 'School email', ageEligible: 'Meets minimum working age',
  github: 'GitHub', linkedin: 'LinkedIn', gpa: 'GPA and scale', country: 'Country (2-letter code)',
  countryCode: 'Calling code', expectedGraduation: 'Expected graduation', completedAt: 'Credential completed on',
  citizenship: 'Citizen of this country', residenceStatus: 'Residence status', rightToWork: 'Right to work',
  sponsorshipNow: 'Sponsorship required now', sponsorshipFuture: 'Sponsorship required in future',
  metric: 'Measured result', contribution: 'Contribution ownership', sourceAnswer: 'How you heard about the role',
  sourceId: 'Source document / proposal ID', evidenceFactIds: 'Supporting fact IDs', document: 'Document version',
  perRequest: 'Per request', perRun: 'Per run', perDay: 'Per day', line1: 'Street address', line2: 'Address line 2',
  number: 'Phone number', currentLocation: 'Current location (city, state, country)',
  windows: 'Term windows', schools: 'Schools', employment: 'Employment',
  answers: 'Employer disclosures', countries: 'Countries', masters: 'Resume masters by role',
};
export function labelFor(key: string): string {
  return overrides[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase());
}
export function nonNull(meta: FieldMeta): FieldMeta {
  return meta.anyOf?.find((entry) => entry.type !== 'null') ?? meta;
}
const emptyValue = (meta: FieldMeta): unknown => {
  const node = nonNull(meta);
  if (node.const !== undefined) return node.const;
  if (node.type === 'array') return [];
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, child]) => [key, emptyValue(child)]));
  return '';
};

export function NativeValue({ meta, value, onChange, id, label, documents = [], control, invalid = false, describedBy }: {
  meta: FieldMeta; value: unknown; onChange: (value: unknown) => void;
  id: string; label: string; documents?: DocumentOption[]; control?: string; invalid?: boolean; describedBy?: string;
}) {
  const node = nonNull(meta);
  const nullable = meta.anyOf?.some((entry) => entry.type === 'null') === true;
  const cleared = nullable ? null : '';
  const common = { id, 'aria-label': label, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  if (control === 'document') {
    const ref = value as { documentId?: string; version?: number } | null;
    const available = documents.filter((d) => d.state === 'available');
    return <select {...common} value={ref?.documentId ?? ''} onChange={(e) => {
      const doc = available.find((d) => d.id === e.target.value);
      onChange(doc ? { documentId: doc.id, version: doc.version } : null);
    }}><option value="">Choose available document</option>
      {ref?.documentId && !available.some((d) => d.id === ref.documentId) &&
        <option value={ref.documentId}>Unavailable document, version {ref.version}</option>}
      {available.map((d) => <option key={d.id} value={d.id}>{d.name} / v{d.version}</option>)}
    </select>;
  }
  if (node.oneOf?.some((entry) => entry.properties?.precision)) {
    const date = value as { precision: string; value: string } | null;
    const precision = date?.precision ?? 'month';
    return <div className={styles.compound}>
      <select aria-label={`${label} precision`} value={precision} onChange={(e) => {
        // Increasing precision never invents a month or day.
        const length = e.target.value === 'year' ? 4 : e.target.value === 'month' ? 7 : 10;
        onChange({ precision: e.target.value, value: (date?.value?.length ?? 0) >= length ? date!.value.slice(0, length) : '' });
      }}>
        <option value="year">Year</option><option value="month">Month</option><option value="day">Day</option>
      </select>
      <input {...common} type={precision === 'year' ? 'text' : precision === 'month' ? 'month' : 'date'}
        inputMode={precision === 'year' ? 'numeric' : undefined}
        maxLength={precision === 'year' ? 4 : undefined} value={date?.value ?? ''}
        onChange={(e) => onChange(e.target.value ? { precision, value: e.target.value } : null)} />
    </div>;
  }
  if (node.type === 'boolean') return <div className={styles.checks} role="group" {...common}>
    {[true, false].map((option) => <label key={String(option)}>
      <input type="radio" name={id} aria-label={`${label}: ${option ? 'Yes' : 'No'}`}
        checked={value === option} onChange={() => onChange(option)} />{option ? 'Yes' : 'No'}
    </label>)}
  </div>;
  if (node.enum) return <select {...common} value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || cleared)}>
    <option value="">Not answered</option>{node.enum.map((option) => <option key={option} value={option}>{labelFor(option)}</option>)}
  </select>;
  if (node.type === 'array' && node.items?.enum) return <div className={styles.checks} role="group" {...common}>
    {node.items.enum.map((option) => <label key={option}>
      <input type="checkbox" aria-label={`${label}: ${labelFor(option)}`} checked={Array.isArray(value) && value.includes(option)}
        onChange={(e) => onChange(e.target.checked ? [...(Array.isArray(value) ? value : []), option] : (value as string[]).filter((v) => v !== option))} />
      {labelFor(option)}
    </label>)}
  </div>;
  if (node.type === 'array') {
    const values = Array.isArray(value) ? value : [];
    return <div className={styles.field} role="group" {...common}>
      {values.map((entry, index) => <div className={styles.row} key={index}>
        <input aria-label={`${label} ${index + 1}`} value={String(entry)} maxLength={node.items?.maxLength}
          onChange={(e) => onChange(values.map((v, i) => i === index ? e.target.value : v))} style={{ flex: 1 }} />
        <button className={`${styles.button} ${styles.icon}`} type="button" aria-label={`Remove ${label} ${index + 1}`} title={`Remove ${label} ${index + 1}`}
          onClick={() => onChange(values.filter((_, i) => i !== index))}><Close /></button>
      </div>)}
      <button className={styles.button} type="button" disabled={values.length >= (node.maxItems ?? 100)}
        onClick={() => onChange([...values, ''])}>Add {label.toLowerCase()} entry</button>
    </div>;
  }
  if (node.type === 'object') {
    const values = (value && typeof value === 'object' ? value : emptyValue(node)) as Record<string, unknown>;
    return <div className={styles.compound} role="group" {...common}>
      {Object.entries(node.properties ?? {}).filter(([, child]) => child.const === undefined).map(([key, child]) =>
        <div className={styles.field} key={key}>
          <label htmlFor={`${id}-${key}`}>{labelFor(key)}</label>
          <NativeValue meta={child} value={values[key]} id={`${id}-${key}`} label={`${label}: ${labelFor(key)}`}
            invalid={invalid} describedBy={describedBy} onChange={(next) => onChange({ ...values, [key]: next })} />
        </div>)}
      {nullable && value !== null && <div className={styles.wide}>
        <button type="button" className={styles.button} onClick={() => onChange(null)}>Clear {label}</button>
      </div>}
    </div>;
  }
  if (control === 'textarea') return <textarea {...common} rows={3} maxLength={node.maxLength} value={String(value ?? '')} onChange={(e) => onChange(e.target.value || cleared)} />;
  return <input {...common} type={node.type === 'number' || node.type === 'integer' ? 'number' :
    control === 'email' ? 'email' : control === 'url' ? 'url' : control === 'tel' ? 'tel' : 'text'}
    min={node.minimum} max={node.maximum} step={node.type === 'integer' ? 1 : 'any'}
    maxLength={node.maxLength} value={typeof value === 'string' || typeof value === 'number' ? value : ''}
    onChange={(e) => onChange(e.target.value === '' ? cleared : node.type === 'number' || node.type === 'integer' ? e.target.valueAsNumber : e.target.value)} />;
}

function FactField({ fact, meta, path, name, onChange, issues, documents }: {
  fact: Fact; meta: FieldMeta; path: string; name: string; onChange: (value: unknown) => void;
  issues: FieldIssues; documents: DocumentOption[];
}) {
  const id = `fact-${fact.id}`;
  const label = labelFor(name);
  const issue = Object.entries(issues).find(([key]) => key === path || key.startsWith(`${path}.`))?.[1];
  const valueSchema = meta.properties!.value;
  function changeValue(value: unknown) {
    const state = value === null ? 'unknown' : fact.state === 'candidate' ? 'candidate' : 'confirmed';
    onChange({ ...fact, value, state, confirmedAt: state === 'confirmed' ? new Date().toISOString() : null,
      provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: null } });
  }
  const compound = ['address', 'metric', 'gpa', 'money'].includes(meta.control ?? '');
  return <fieldset className={`${styles.field} ${compound ? styles.wide : ''}`} data-fact-path={path}>
    <legend>{label}{fact.units && <span className={styles.muted}> ({labelFor(fact.units).toLowerCase()})</span>}</legend>
    <div className={styles.state}>
      <NativeValue meta={valueSchema} value={fact.value} onChange={changeValue} id={id} label={label}
        documents={documents} control={meta.control} invalid={!!issue} describedBy={issue ? `${id}-error` : undefined} />
      <select aria-label={`${label} answer state`} value={fact.state} onChange={(e) => {
        const state = e.target.value as Fact['state'];
        onChange({ ...fact, state, value: ['confirmed', 'candidate'].includes(state) ? fact.value : null,
          confirmedAt: state === 'confirmed' ? new Date().toISOString() : null });
      }}>
        <option value="unknown">Not answered</option><option value="declined">Decline</option>
        <option value="not_applicable">Not applicable</option><option value="candidate">Candidate</option>
        <option value="confirmed">Confirmed</option>
      </select>
    </div>
    {issue && <p id={`${id}-error`} className={styles.error} role="alert">{issue}</p>}
    <details className={styles.meta}>
      <summary>Source: {fact.provenance.source} / {labelFor(fact.state)} / v{fact.version}</summary>
      <p>Fact ID: {fact.id}</p>
      {fact.confirmedAt && <p>Confirmed: <time dateTime={fact.confirmedAt}>{new Date(fact.confirmedAt).toLocaleString()}</time></p>}
      {fact.provenance.sourceId && <p>Source: {fact.provenance.sourceId} / v{fact.provenance.sourceVersion}</p>}
      {fact.provenance.excerpt && <p>{fact.provenance.excerpt}</p>}
      <NativeValue meta={meta.properties!.scope} value={fact.scope} id={`${id}-scope`} label={`${label} scope`}
        onChange={(scope) => onChange({ ...fact, scope })} />
    </details>
  </fieldset>;
}

function createEntry(path: (string | number)[]): unknown {
  let schema: z.ZodType = ProfileSections[path[0] as ProfileSection];
  for (const key of path.slice(1)) {
    while (schema instanceof z.ZodDefault) schema = schema.unwrap() as z.ZodType;
    schema = schema instanceof z.ZodArray ? schema.element as z.ZodType : (schema as z.ZodObject).shape[key];
  }
  while (schema instanceof z.ZodDefault) schema = schema.unwrap() as z.ZodType;
  return ((schema as z.ZodArray).element as z.ZodType).parse({});
}

export function SectionFields({ meta, value, path, onChange, issues, documents }: {
  meta: FieldMeta; value: Record<string, unknown>; path: (string | number)[];
  onChange: (value: Record<string, unknown>) => void; issues: FieldIssues; documents: DocumentOption[];
}) {
  const issue = issues[path.join('.')];
  return <div className={styles.fields}>
    {issue && <div className={`${styles.wide} ${styles.alert}`} role="alert">
      <p>{issue}</p>
      <div className={styles.row}>
        {Object.entries(meta.properties ?? {}).filter(([, field]) => field.fact).map(([name]) => {
          const id = `fact-${(value[name] as Fact).id}`;
          return <a key={name} href={`#${id}`} onClick={(event) => {
            event.preventDefault();
            const field = document.getElementById(id);
            const control = field?.matches('input, select, textarea') ? field :
              field?.querySelector<HTMLElement>('input, select, textarea');
            control?.focus();
          }}>{labelFor(name)}</a>;
        })}
      </div>
    </div>}
    {Object.entries(meta.properties ?? {}).filter(([key]) => !['id', 'version', 'schemaVersion'].includes(key)).map(([name, field]) => {
      const childPath = [...path, name];
      if (field.fact) return <FactField key={name} fact={value[name] as Fact} meta={field} name={name} path={childPath.join('.')}
        onChange={(next) => onChange({ ...value, [name]: next })} issues={issues} documents={documents} />;
      if (field.type === 'array') {
        const entries = value[name] as Record<string, unknown>[];
        return <div className={styles.collection} key={name}>
          <div className={styles.row}><h3>{labelFor(name)}</h3>
            <button className={styles.button} type="button" disabled={entries.length >= (field.maxItems ?? 100)}
              onClick={() => onChange({ ...value, [name]: [...entries, createEntry(childPath)] })}>Add {labelFor(name).toLowerCase()} entry</button>
          </div>
          {issues[childPath.join('.')] && <p className={styles.error} role="alert">{issues[childPath.join('.')]}</p>}
          {!entries.length && <p className={styles.muted}>No entries.</p>}
          {entries.map((entry, index) => <div className={styles.entry} key={String(entry.id)}>
            <div className={styles.row}><span>{labelFor(name)} {index + 1}</span>
              <button className={`${styles.button} ${styles.icon}`} type="button" aria-label={`Remove ${labelFor(name)} ${index + 1}`} title={`Remove ${labelFor(name)} ${index + 1}`}
                onClick={() => onChange({ ...value, [name]: entries.filter((_, i) => i !== index) })}><Close /></button>
            </div>
            <SectionFields meta={field.items!} value={entry} path={[...childPath, index]} issues={issues} documents={documents}
              onChange={(next) => onChange({ ...value, [name]: entries.map((v, i) => i === index ? next : v) })} />
          </div>)}
        </div>;
      }
      return null;
    })}
  </div>;
}

export function completion(value: unknown): { answered: number; total: number } {
  if (!value || typeof value !== 'object') return { answered: 0, total: 0 };
  if ('state' in value) return { answered: ['confirmed', 'declined', 'not_applicable'].includes(String(value.state)) ? 1 : 0, total: 1 };
  return Object.values(value).reduce((sum, child) => {
    const count = completion(child);
    return { answered: sum.answered + count.answered, total: sum.total + count.total };
  }, { answered: 0, total: 0 });
}
