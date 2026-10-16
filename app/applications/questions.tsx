'use client';

import { useEffect, useRef, useState } from 'react';
import { InboxControl, initialView, pollingDelay, type InboxView } from '../inbox/control';
import { AnswerAllForm, QuestionForm, answerable, kindNames } from '../inbox/question-form';
import styles from '../inbox/inbox.module.css';

/** The question inbox, polled for this page; each Auto Apply row shows its own questions. */
export function useQuestions(onAnswered: () => void) {
  const [view, setView] = useState(initialView);
  const control = useRef<InboxControl | null>(null);
  const answered = useRef(onAnswered);
  useEffect(() => { answered.current = onAnswered; }, [onAnswered]);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = localStorage; } catch { /* Answers still work without browser recovery. */ }
    let open = -1;
    const instance = new InboxControl((next) => {
      setView(next);
      // An answer resumes its application; reload the rows when the open count drops.
      const now = next.inbox?.unresolved ?? -1;
      if (open >= 0 && now >= 0 && now < open) answered.current();
      if (now >= 0) open = now;
    }, storage);
    control.current = instance;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      clearTimeout(timer);
      if (!alive || document.visibilityState === 'hidden') return;
      if (navigator.onLine) await instance.refresh(); else instance.offline();
      if (alive) timer = setTimeout(() => void poll(), pollingDelay(instance.view.failures));
    }
    const wake = () => { if (document.visibilityState === 'visible') void poll(); };
    const unload = (event: BeforeUnloadEvent) => { if (instance.dirty) { event.preventDefault(); event.returnValue = ''; } };
    void poll();
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('beforeunload', unload);
    return () => {
      alive = false; clearTimeout(timer); instance.dispose(); control.current = null;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
  return { view, control: control.current };
}

export function ApplicationQuestions({ applicationId, view, control }: { applicationId: string; view: InboxView; control: InboxControl | null }) {
  // ponytail: the newest 50 notifications; older questions show after "Load older" in a later change if ever needed.
  const open = (view.inbox?.items ?? []).filter((item) => item.applicationId === applicationId && item.question && !item.question.resolved);
  // One notification per question; a reopened question can have several.
  const questions = [...new Map(open.map((item) => [item.question!.id, item.question!])).values()];
  const answers = questions.filter(answerable);
  const items = open.filter((item) => !answerable(item.question!));
  if (!control || !questions.length) return null;
  if (answers.length) return <div>
    <AnswerAllForm questions={answers} control={control} view={view} />
    {items.length > 0 && <p className={styles.muted}>{items.length} more item{items.length === 1 ? '' : 's'} need you after these answers.</p>}
  </div>;
  const selected = view.selected && items.some((item) => item.question!.id === view.selected!.id) ? view.selected : null;
  if (selected) return <div>
    <QuestionForm key={selected.id} question={selected} control={control} view={view} />
    {items.length > 1 && <button type="button" className={styles.button} onClick={() => control.back()}>All items</button>}
  </div>;
  return <ul className={styles.list} aria-label="Questions">
    {items.map((item) => <li className={styles.item} key={item.eventId}>
      <div className={styles.row}>
        <span className={styles.tag}>{kindNames[item.question!.descriptor.kind]}</span>
        {!item.read && <span className={styles.muted}>Unread</span>}
      </div>
      <p>{item.question!.descriptor.originalWording}</p>
      <p className={styles.muted}>{item.question!.descriptor.reason}</p>
      <div className={styles.row}>
        <button type="button" className={styles.button} disabled={view.busy} onClick={() => void control.select(item.question!)}>Open</button>
        {!item.read && <button type="button" className={styles.button} disabled={view.busy}
          onClick={() => void control.markRead(item.eventId)}>Mark read</button>}
        <time className={styles.muted} dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
      </div>
    </li>)}
  </ul>;
}
