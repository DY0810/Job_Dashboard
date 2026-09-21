'use client';

import { useCallback, useState } from 'react';
import { z } from 'zod';
import type { QuestionDetail } from '../../lib/applications/question-protocol';
import DocumentsPane from '../profile/documents-pane';
import type { DocumentOption } from '../profile/fields';
import { answerCommand, DocumentSchema, eligibleDocuments, type Document } from './answer';
import { sameQuestion, type Edit, type InboxControl, type InboxView } from './control';
import styles from './inbox.module.css';

const scopeNames = { application: 'This application', employer: 'This employer', equivalent: 'Equivalent reviewed questions' };
export const kindNames: Record<string, string> = {
  needs_answer: 'Answer needed', needs_document: 'Document needed', needs_login: 'Login needed',
  needs_verification: 'Verification needed', needs_policy_decision: 'Policy decision',
  provider_unavailable: 'Provider unavailable', failed: 'Failed',
};

export function QuestionForm({ question: q, control, view }: { question: QuestionDetail; control: InboxControl; view: InboxView }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [error, setError] = useState('');
  const [reviewed, setReviewed] = useState(false);
  const onDocuments = useCallback((items: DocumentOption[]) => {
    const parsed = z.array(DocumentSchema).safeParse(items);
    if (parsed.success) { setDocuments(parsed.data); setError(''); }
    else setError('Document response is incompatible. Refresh documents before choosing a file.');
  }, []);
  const draft = view.snapshot.drafts[q.id];
  const edit = draft.desired;
  const field = q.descriptor.field;
  const stale = !sameQuestion(draft.question, q);
  const pending = view.snapshot.pending;
  const intervention = ['needs_login', 'needs_verification'].includes(q.descriptor.kind);
  const answerForm = ['needs_answer', 'needs_document', 'needs_policy_decision'].includes(q.descriptor.kind) && field.type !== 'intervention';
  function change(patch: Partial<Edit>) { setError(''); control.edit({ ...edit, ...patch }); }
  const id = `question-${q.id}`;
  return <section aria-label="Current question">
    <div className={styles.row}><span className={styles.tag}>{kindNames[q.descriptor.kind]}</span>
      <span>{q.resolved ? 'Resolved' : `${q.waitingCount} applications waiting`}</span>
      <span className={styles.muted}>{q.descriptor.required ? 'Required' : 'Optional'}</span>
    </div>
    <h3>{q.application.company} / {q.application.role}</h3>
    <p id={`${id}-wording`}>{q.descriptor.originalWording}</p>
    <p className={styles.muted}>{q.descriptor.reason}</p>
    <dl className={styles.detail}>
      <dt>Source</dt><dd>{q.application.ats} / {q.application.tenant} / {q.application.requisition}</dd>
      <dt>Meaning</dt><dd>{q.descriptor.meaning.id}</dd>
      <dt>Scope</dt><dd>{q.descriptor.scope.employer ?? q.application.company} / {q.descriptor.scope.timeframe}
        {q.descriptor.scope.country ? ` / ${q.descriptor.scope.country}` : ''}
        {q.descriptor.scope.includesSubsidiaries ? ' / includes subsidiaries' : ''}
        {q.descriptor.scope.validFrom ? ` / from ${q.descriptor.scope.validFrom.value} (${q.descriptor.scope.validFrom.precision})` : ''}
        {q.descriptor.scope.validUntil ? ` / until ${q.descriptor.scope.validUntil.value} (${q.descriptor.scope.validUntil.precision})` : ''}
      </dd>
      {q.descriptor.provenance.excerpt && <><dt>Context</dt><dd>{q.descriptor.provenance.excerpt}</dd></>}
      <dt>Schema</dt><dd>{q.descriptor.schemaVersion} / revision {q.revision}</dd>
    </dl>
    {intervention && <>
      <p>Paired worker: {q.application.workerId}</p>
      <p className={styles.muted}>Host: {q.application.tenant} / {q.application.ats}</p>
      {q.focus && <p role="status">Browser: {q.focus.status}{q.focus.reason ? ` / ${q.focus.reason}` : ''}</p>}
      <button type="button" className={styles.button} disabled={view.busy || !!pending || q.resolved}
        onClick={() => void control.focus()}>Focus paired browser</button>
    </>}
    {!intervention && !answerForm && <p className={styles.muted}>Waiting for the worker or policy configuration to change.</p>}
    {answerForm && <>
      {stale && <div className={styles.alert} role="alert">
        <p>The question, options, profile or policy changed. Your earlier draft is retained.</p>
        <button type="button" className={styles.button} disabled={!!pending || view.busy}
          onClick={() => { control.acceptCurrent(); setReviewed(false); }}>Use reviewed current question</button>
      </div>}
      {!q.canAnswer && <p role="status">{q.resolved ? 'Answer recorded. This question is read-only.' : 'This question is read-only.'}</p>}
      {q.resolved && q.canAnswer && <p role="status">{draft.dirty ?
        'This question is resolved. Your newer draft has not been sent.' : 'Answer recorded. You can save an updated answer.'}</p>}
      <form className={styles.form} aria-label="Answer question" onSubmit={(event) => {
        event.preventDefault();
        try { setError(''); void control.answer(answerCommand(q, edit, documents)); }
        catch (next) { setError(next instanceof Error ? next.message : 'Check the answer.'); }
      }}>
        <fieldset disabled={view.locked || !q.canAnswer}>
          <legend>Answer</legend>
          {(q.canBlank || q.canDecline) && <div className={styles.field}>
            <label htmlFor={`${id}-mode`}>Response</label>
            <select id={`${id}-mode`} value={edit.mode} onChange={(event) => change({ mode: event.target.value as Edit['mode'] })}>
              <option value="answer">Provide answer</option>
              {q.canBlank && <option value="blank">Leave blank</option>}
              {q.canDecline && <option value="decline">Decline / {field.declineValue}</option>}
            </select>
          </div>}
          {edit.mode === 'answer' && <AnswerInput question={q} edit={edit} change={change} documents={documents} />}
          <div className={styles.field}>
            <label htmlFor={`${id}-reuse`}>Use answer for</label>
            <select id={`${id}-reuse`} value={edit.reuse} onChange={(event) => change({ reuse: event.target.value as Edit['reuse'] })}>
              {!q.allowedReuse.includes(edit.reuse) && <option value={edit.reuse} disabled>Previous scope unavailable</option>}
              {q.allowedReuse.map((scope) => <option key={scope} value={scope}>{scopeNames[scope]}</option>)}
            </select>
          </div>
        </fieldset>
        {error && <p role="alert" className={styles.alert}>{error}</p>}
        <div><button type="submit" className={styles.button} disabled={view.busy || !!pending || stale || !q.canAnswer || view.locked}>
          {q.resolved ? 'Save updated answer' : 'Save answer'}
        </button></div>
      </form>
      {!q.resolved && q.canAnswer && !q.descriptor.meaning.reviewId && <div className={styles.form}>
        <label className={styles.choice}><input type="checkbox" checked={reviewed} disabled={view.busy || !!pending}
          onChange={(event) => setReviewed(event.target.checked)} />I reviewed this exact wording, options and scope for answer reuse</label>
        <div><button type="button" className={styles.button} disabled={!reviewed || view.busy || !!pending}
          onClick={() => { void control.review(); setReviewed(false); }}>Confirm meaning for reuse</button></div>
      </div>}
      {field.type === 'document' && q.canAnswer && <div className={styles.documents}>
        <p className={styles.muted}>Required: {field.documentKinds.join(', ')} / {field.mimeTypes.join(', ')} / up to {Math.floor(field.maxBytes / 1024)} KB</p>
        <DocumentsPane api={control.api} ownerId={view.ownerId!} signal={control.signal} onDocuments={onDocuments} idPrefix="inbox-document" />
      </div>}
    </>}
  </section>;
}

function AnswerInput({ question: q, edit, change, documents }: {
  question: QuestionDetail; edit: Edit; change: (patch: Partial<Edit>) => void; documents: Document[];
}) {
  const field = q.descriptor.field;
  const id = `answer-${q.id}`;
  if (field.type === 'radio' || field.type === 'boolean' || field.type === 'multiselect') {
    const options = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options;
    return <fieldset aria-label={q.descriptor.originalWording}>
      {options.map((option) => <label key={option.value} className={styles.choice}>
        <input type={field.type === 'multiselect' ? 'checkbox' : 'radio'} name={id} value={option.value}
          checked={field.type === 'multiselect' ? edit.choices.includes(option.value) : edit.input === option.value}
          required={field.type !== 'multiselect'}
          onChange={(event) => change(field.type === 'multiselect' ? {
            choices: event.target.checked ? [...edit.choices, option.value] : edit.choices.filter((value) => value !== option.value),
          } : { input: option.value })} />{option.label}
      </label>)}
      {field.type === 'multiselect' && <p className={styles.muted}>Choose {field.minSelections} to {field.maxSelections}.</p>}
    </fieldset>;
  }
  return <div className={styles.field}>
    <label htmlFor={id}>{q.descriptor.originalWording}</label>
    {field.type === 'textarea' ? <textarea id={id} value={edit.input} required rows={4}
      minLength={field.minLength} maxLength={field.maxLength} onChange={(event) => change({ input: event.target.value })} /> :
      field.type === 'select' ? <select id={id} required value={edit.input} onChange={(event) => change({ input: event.target.value })}>
        <option value="">Choose...</option>
        {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select> : field.type === 'document' ? <select id={id} required value={edit.input} onChange={(event) => change({ input: event.target.value })}>
        <option value="">Choose available document...</option>
        {eligibleDocuments(q, documents).map((doc) => <option key={doc.id} value={doc.id}>{doc.name} / v{doc.version}</option>)}
      </select> : field.type === 'text' ? <input id={id} required type={field.format === 'plain' ? 'text' : field.format}
        value={edit.input} minLength={field.minLength} maxLength={field.maxLength} onChange={(event) => change({ input: event.target.value })} /> :
        field.type === 'number' ? <>
          <input id={id} type="number" required value={edit.input} min={field.min ?? undefined} max={field.max ?? undefined}
            step={field.integer ? 1 : 10 ** -field.precision} onChange={(event) => change({ input: event.target.value })} />
          <span className={styles.muted}>{field.units} / {field.precision} decimal places
            {field.min !== null ? ` / min ${field.min}` : ''}{field.max !== null ? ` / max ${field.max}` : ''}</span>
        </> : field.type === 'date' ? <>
          <input id={id} type={field.precision === 'year' ? 'number' : field.precision === 'month' ? 'month' : 'date'}
            required value={edit.input} min={field.min ?? (field.precision === 'year' ? '1900' : undefined)}
            max={field.max ?? (field.precision === 'year' ? '2199' : undefined)} step={1}
            onChange={(event) => change({ input: event.target.value })} />
          <span className={styles.muted}>Precision: {field.precision}</span>
        </> : null}
  </div>;
}
