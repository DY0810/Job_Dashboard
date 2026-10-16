'use client';

import { useCallback, useState } from 'react';
import { z } from 'zod';
import type { QuestionDetail } from '../../lib/applications/question-protocol';
import DocumentsPane from '../profile/documents-pane';
import type { DocumentOption } from '../profile/fields';
import { answerCommand, DocumentSchema, eligibleDocuments, type Document } from './answer';
import { emptyEdit, type Edit, type InboxControl, type InboxView } from './control';
import styles from './inbox.module.css';

export const kindNames: Record<string, string> = {
  needs_answer: 'Answer needed', needs_document: 'Document needed', needs_login: 'Login needed',
  needs_verification: 'Verification needed', needs_policy_decision: 'Policy decision',
  provider_unavailable: 'Provider unavailable', failed: 'Failed',
};

export const answerKinds = ['needs_answer', 'needs_document', 'needs_policy_decision'];
export const answerable = (q: QuestionDetail) => answerKinds.includes(q.descriptor.kind) && q.descriptor.field.type !== 'intervention';

/** A login, verification or other non-answer blocker; answers go through AnswerAllForm. */
export function QuestionForm({ question: q, control, view }: { question: QuestionDetail; control: InboxControl; view: InboxView }) {
  const pending = view.snapshot.pending;
  const intervention = ['needs_login', 'needs_verification'].includes(q.descriptor.kind);
  return <section aria-label="Current question">
    <div className={styles.row}><span className={styles.tag}>{kindNames[q.descriptor.kind]}</span>
      <span className={styles.muted}>{q.descriptor.required ? 'Required' : 'Optional'}</span>
    </div>
    <h3>{q.application.company} / {q.application.role}</h3>
    <p>{q.descriptor.originalWording}</p>
    <p className={styles.muted}>{q.descriptor.reason}</p>
    {intervention ? <>
      <p>Paired worker: {q.application.workerId}</p>
      <p className={styles.muted}>Host: {q.application.tenant} / {q.application.ats}</p>
      {q.focus && <p role="status">Browser: {q.focus.status}{q.focus.reason ? ` / ${q.focus.reason}` : ''}</p>}
      <button type="button" className={styles.button} disabled={view.busy || !!pending || q.resolved}
        onClick={() => void control.focus()}>Focus paired browser</button>
    </> : <p className={styles.muted}>Waiting for the worker or policy configuration to change.</p>}
  </section>;
}

/** Every open question of one application in a single form, sent with one Submit. */
export function AnswerAllForm({ questions, control, view }: { questions: QuestionDetail[]; control: InboxControl; view: InboxView }) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [error, setError] = useState('');
  const onDocuments = useCallback((items: DocumentOption[]) => {
    const parsed = z.array(DocumentSchema).safeParse(items);
    if (parsed.success) { setDocuments(parsed.data); setError(''); }
    else setError('Document response is incompatible. Refresh documents before choosing a file.');
  }, []);
  const pending = view.snapshot.pending;
  const editOf = (q: QuestionDetail) => view.snapshot.drafts[q.id]?.desired ?? emptyEdit();
  const readOnly = questions.some((q) => !q.canAnswer);
  return <form className={styles.form} aria-label="Answer questions" onSubmit={(event) => {
    event.preventDefault();
    setError('');
    const answers = [];
    for (const q of questions) {
      try { answers.push({ question: q, body: answerCommand(q, editOf(q), documents) }); }
      catch (next) { setError(`${q.descriptor.originalWording}: ${next instanceof Error ? next.message : 'Check the answer.'}`); return; }
    }
    void control.answerAll(answers);
  }}>
    <p className={styles.muted}>{questions.length} question{questions.length === 1 ? '' : 's'} for {questions[0].application.company} / {questions[0].application.role}.
      Answer all of them, then submit once. Answers are used for this application only.</p>
    {readOnly && <p role="status">Some questions are read-only until the worker or policy is available again.</p>}
    <fieldset disabled={view.locked} className={styles.form}>
      {questions.map((q, index) => {
        const edit = editOf(q), field = q.descriptor.field, id = `question-${q.id}`;
        const change = (patch: Partial<Edit>) => { setError(''); control.edit({ ...edit, ...patch }, q); };
        return <fieldset key={q.id} disabled={!q.canAnswer} className={styles.item}>
          <legend>{index + 1}. {q.descriptor.originalWording}</legend>
          <p className={styles.muted}>{q.descriptor.required ? 'Required' : 'Optional'}{q.descriptor.provenance.excerpt &&
            q.descriptor.provenance.excerpt !== q.descriptor.originalWording ? ` / ${q.descriptor.provenance.excerpt}` : ''}</p>
          {(q.canBlank || q.canDecline) && <div className={styles.field}>
            <label htmlFor={`${id}-mode`}>Response</label>
            <select id={`${id}-mode`} value={edit.mode} onChange={(event) => change({ mode: event.target.value as Edit['mode'] })}>
              <option value="answer">Provide answer</option>
              {q.canBlank && <option value="blank">Leave blank</option>}
              {q.canDecline && <option value="decline">Decline / {field.declineValue}</option>}
            </select>
          </div>}
          {edit.mode === 'answer' && <AnswerInput question={q} edit={edit} change={change} documents={documents} />}
        </fieldset>;
      })}
    </fieldset>
    {questions.some((q) => q.descriptor.field.type === 'document' && q.canAnswer) && <div className={styles.documents}>
      <DocumentsPane api={control.api} ownerId={view.ownerId!} signal={control.signal} onDocuments={onDocuments} idPrefix="inbox-document" />
    </div>}
    {error && <p role="alert" className={styles.alert}>{error}</p>}
    {view.error && <p role="alert" className={styles.alert}>{view.error}</p>}
    {view.notice && <p role="status">{view.notice}</p>}
    <div className={styles.row}>
      <button type="submit" className={styles.button} disabled={view.busy || !!pending || view.locked || readOnly}>
        {view.busy ? 'Submitting...' : `Submit ${questions.length} answer${questions.length === 1 ? '' : 's'}`}</button>
      {pending && <button type="button" className={styles.button} disabled={view.busy} onClick={() => void control.retry()}>Retry pending answer</button>}
    </div>
  </form>;
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
