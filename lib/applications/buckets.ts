// Client-safe: which Auto Apply list a row belongs in, and what its card asks. Archiving only hides; it never changes the application.
import { isAwaitingSubmitApproval, isTerminalState, type ApplicationState } from './state.ts';
import { PARKED_STEPS } from './worker-protocol.ts';

const DAY_MS = 86_400_000;
export const ARCHIVE_AFTER_MS = 14 * DAY_MS;
export const ARCHIVE_KEEP_MS = 30 * DAY_MS;

type Row = { state: ApplicationState; reasonCode?: string | null; hiddenAt: number | null; createdAt: number };

/** When the row was (or will be) archived: hidden by the applicant, else 14 days after it was created. */
export const archivedAt = (app: Row) => app.hiddenAt ?? app.createdAt + ARCHIVE_AFTER_MS;

/** Rows mid-submission are never auto-archived: the employer may already have them. Nor is a row in Live, which waits on the
 * worker or the applicant. listRuns mirrors this in SQL. */
export const IN_FLIGHT_STATES: ApplicationState[] = ['submitting', 'submission_unknown'];

export function bucket(app: Row, now: number): 'action' | 'applied' | 'archived' | null {
  if (app.hiddenAt === null && app.state === 'submitted') return 'applied';
  if ((app.hiddenAt === null && IN_FLIGHT_STATES.includes(app.state)) || inLive({ ...app, reasonCode: app.reasonCode ?? null })) return 'action';
  const at = archivedAt(app);
  if (at > now) return 'action';
  return now - at < ARCHIVE_KEEP_MS ? 'archived' : null;
}

/** States in which the worker is working a row (or about to): the Live tab shows them. 'ready' is an approved form it fills again and submits. */
export const LIVE_STATES: readonly ApplicationState[] = ['screening', 'tailoring', 'filling', 'ready', 'submitting'];
/** Live also keeps a form that is waiting on the applicant's answers or approval, so it can be finished from there. */
export const inLive = (app: { state: ApplicationState; reasonCode: string | null; hiddenAt: number | null }) => app.hiddenAt === null &&
  (LIVE_STATES.includes(app.state) || app.reasonCode === 'question_unresolved' || isAwaitingSubmitApproval(app.state, app.reasonCode));
/** A frame older than this means the worker is not on the page right now (between stages, or stopped). */
export const FRESH_MS = 20_000;
const parked: readonly string[] = Object.values(PARKED_STEPS);
/**
 * The worker is on this row's form right now, so its card shows the newest step and picture. Any state the worker works will
 * do: rows reload less often than frames, so a row may still read 'tailoring' while its form is being filled. The frame the
 * worker posted as it parked the form never counts: after Apply or answers the row is worked again before the worker is back.
 */
export const isWatching = (app: { state: ApplicationState }, frame: { updatedAt: number; step: string } | undefined, now: number) =>
  !!frame && now - frame.updatedAt < FRESH_MS && LIVE_STATES.includes(app.state) && !parked.includes(frame.step);
/**
 * The frames whose row the page holds in another state, or not at all, and the rows whose frame left the live list since the
 * last poll (`before`), as one key ('' for none): those rows moved since they loaded, so the Live tab reloads them.
 * Once per key: a row listRuns leaves out never catches up.
 */
export function rowsBehind(frames: { applicationId: string; state: ApplicationState }[], rows: { id: string; state: ApplicationState }[],
  before: { applicationId: string }[] = []) {
  const states = new Map(rows.map((row) => [row.id, row.state]));
  const now = new Set(frames.map((frame) => frame.applicationId));
  return [...frames.filter((frame) => states.get(frame.applicationId) !== frame.state).map((frame) => `${frame.applicationId} ${frame.state}`),
    ...before.filter((frame) => !now.has(frame.applicationId)).map((frame) => `${frame.applicationId} left`)].sort().join('\n');
}

/** Open questions by application, each once: a reopened question has one notification per time it was asked. */
type Asked = { resolved: boolean; waitingCount: number; canAnswer: boolean };
/** Unanswered and still asked: a question a policy change closed stays in the inbox but nothing can answer it. */
export const isOpenQuestion = (q: Asked) => !q.resolved && (q.waitingCount > 0 || q.canAnswer);

export function openQuestions<Q extends Asked & { id: string }>(items: { applicationId: string; question: Q | null }[]) {
  const asked = new Map<string, Q[]>();
  for (const { applicationId, question } of items) {
    const here = asked.get(applicationId) ?? [];
    if (question && isOpenQuestion(question) && !here.some((item) => item.id === question.id)) asked.set(applicationId, [...here, question]);
  }
  return asked;
}

/** The questions a row's card asks, and whether it restarts instead. A stopped row takes no answers (its form is
 * read-only), and a needs_answer the worker parked with no question has nothing to answer and nothing resumes it.
 * A row waiting on its questions (still loading) or on its paused run is not parked. */
export function rowAsks<Q>(app: { state: ApplicationState; reasonCode: string | null }, open: Q[] = []) {
  const questions = isTerminalState(app.state) ? [] : open;
  return { questions, restart: app.state === 'needs_answer' && !questions.length &&
    !['question_unresolved', 'run_paused'].includes(app.reasonCode ?? '') };
}
