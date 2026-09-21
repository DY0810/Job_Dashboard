'use client';

import Link from 'next/link';
import { Bell, X, ArrowLeft, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { InboxControl, initialView, pollingDelay } from './inbox/control';
import { QuestionForm, kindNames } from './inbox/question-form';
import styles from './inbox/inbox.module.css';

export function NotificationBell() {
  const [view, setView] = useState(initialView);
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const control = useRef<InboxControl | null>(null);
  useEffect(() => {
    let storage: Storage | null = null;
    try { storage = localStorage; } catch { /* Inbox still works without browser recovery. */ }
    const instance = new InboxControl(setView, storage);
    control.current = instance;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      clearTimeout(timer);
      if (!alive || document.visibilityState === 'hidden') return;
      if (navigator.onLine) await instance.refresh();
      else instance.offline();
      if (alive && !document.hidden) {
        clearTimeout(timer);
        timer = setTimeout(() => { void poll(); }, pollingDelay(instance.view.failures));
      }
    }
    const visibility = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') instance.suspend();
      else void poll();
    };
    const focus = () => { if (document.visibilityState === 'visible') void poll(); };
    const offline = () => instance.offline();
    const unload = (event: BeforeUnloadEvent) => {
      if (instance.dirty) { event.preventDefault(); event.returnValue = ''; }
    };
    void poll();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    window.addEventListener('offline', offline);
    window.addEventListener('beforeunload', unload);
    return () => {
      alive = false;
      clearTimeout(timer);
      instance.dispose();
      control.current = null;
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('offline', offline);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
  const counts = !view.locked ? view.inbox : null;
  const countLabel = counts ? `${counts.unread} unread, ${counts.unresolved} unresolved` :
    view.loading ? 'checking session' : 'locked or unavailable';
  function close() {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus();
  }
  function trapFocus(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
    )];
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.current.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  }
  const pending = view.snapshot.pending;
  const instance = control.current;
  return <>
    <button ref={trigger} className={styles.bell} type="button" aria-label={`Notification inbox: ${countLabel}`}
      title={`Private inbox: ${countLabel}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => {
        if (!dialog.current?.open) dialog.current?.showModal();
        setOpen(true);
        void instance?.refresh();
      }}>
      <Bell size={17} strokeWidth={1.5} aria-hidden="true" />
      {view.error ? <span className={styles.badge} aria-hidden="true">!</span> :
        counts && counts.unread > 0 ? <span className={styles.badge} aria-hidden="true">{counts.unread > 99 ? '99+' : counts.unread}</span> : null}
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-label="Private inbox" onKeyDown={trapFocus}
      onCancel={(event) => { event.preventDefault(); close(); }} onClose={() => setOpen(false)}>
      <div className={styles.shell}>
        <div className={styles.toolbar}>
          {view.selected && !view.locked && <button className={`${styles.button} ${styles.icon}`} type="button"
            aria-label="Back to inbox" title="Back to inbox" onClick={() => instance?.back()}><ArrowLeft size={16} aria-hidden="true" /></button>}
          <h2>Private inbox</h2>
          <button type="button" className={`${styles.button} ${styles.icon}`} aria-label="Refresh inbox" title="Refresh inbox"
            disabled={view.busy} onClick={() => void instance?.refresh()}><RefreshCw size={16} aria-hidden="true" /></button>
          <button type="button" autoFocus className={`${styles.button} ${styles.icon}`} aria-label="Close inbox" title="Close inbox" onClick={close}>
            <X size={16} aria-hidden="true" />
          </button>
          <p className={styles.counts}>{counts ? `${counts.unread} unread / ${counts.unresolved} unresolved / ${counts.waitingApplications} applications waiting` :
            view.loading ? 'Loading counts...' : 'Counts unavailable'}</p>
        </div>
        <div className={styles.content}>
          {view.loading && <p role="status">Refreshing inbox...</p>}
          {view.error && <p role="alert" className={styles.alert}>{view.error}</p>}
          {view.locked && !view.loading && <div className={styles.row}>
            <Link href="/sign-in" prefetch={false} target="_blank" rel="noopener noreferrer">Sign in</Link>
            <button type="button" className={styles.button} onClick={() => void instance?.refresh()}>Unlock inbox</button>
          </div>}
          {instance && view.ownerId && <div hidden={view.locked} key={view.ownerId}>
            {view.draftError && <p role="alert" className={styles.alert}>{view.draftError}</p>}
            {view.notice && <p role="status">{view.notice}</p>}
            {view.recoveries.length > 0 && <section aria-label="Inbox draft recovery" className={styles.alert}>
              <h3>Unsaved inbox drafts</h3>
              {view.recoveries.map((recovery, index) => <button type="button" className={styles.button} key={recovery.slot}
                disabled={instance.dirty || view.busy} onClick={() => void instance.recover(index)}>Recover inbox draft {index + 1}</button>)}
            </section>}
            {pending && <section aria-label="Pending inbox request" className={styles.alert}>
              <p>{view.busy ? 'Sending request...' : 'Request outcome unconfirmed. Retry sends the original request, not newer edits.'}</p>
              <button type="button" className={styles.button} disabled={view.busy} onClick={() => void instance.retry()}>Retry pending request</button>
            </section>}
            {view.selected && view.snapshot.drafts[view.selected.id] ?
              <QuestionForm key={view.selected.id} question={view.selected} control={instance} view={view} /> :
              <>
                {view.inbox?.items.length === 0 && <p>No notifications.</p>}
                <ul className={styles.list} aria-label="Notifications">
                  {view.inbox?.items.map((item) => <li className={styles.item} key={item.eventId}>
                    <div className={styles.row}>
                      <span className={styles.tag}>{item.question ? kindNames[item.question.descriptor.kind] :
                        item.kind === 'submitted' ? 'Submitted' : item.kind.replaceAll('_', ' ')}</span>
                      {!item.read && <span className={styles.muted}>Unread</span>}
                      {item.question && <span className={styles.muted}>{item.question.resolved ? 'Resolved' : `${item.question.waitingCount} waiting`}</span>}
                    </div>
                    {item.question ? <>
                      <h3>{item.question.application.company} / {item.question.application.role}</h3>
                      <p>{item.question.descriptor.originalWording}</p>
                      <p className={styles.muted}>{item.question.descriptor.reason}</p>
                    </> : <p>Application {item.applicationId}</p>}
                    <div className={styles.row}>
                      {item.question && <button type="button" className={styles.button} disabled={view.busy}
                        onClick={() => void instance.select(item.question!)}>Open question</button>}
                      {!item.read && <button type="button" className={styles.button} disabled={view.busy}
                        onClick={() => void instance.markRead(item.eventId)}>Mark read</button>}
                      <time className={styles.muted} dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time>
                    </div>
                  </li>)}
                </ul>
                {view.inbox?.nextCursor && <button type="button" className={styles.button} disabled={view.busy || view.loading}
                  onClick={() => void instance.refresh(view.inbox!.nextCursor!)}>Load older notifications</button>}
              </>}
          </div>}
        </div>
      </div>
    </dialog>
  </>;
}
