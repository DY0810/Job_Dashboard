// Client-safe: which Auto Apply list a row belongs in, and what its card asks. Archiving only hides; it never changes the application.
import { isTerminalState, type ApplicationState } from './state.ts';

const DAY_MS = 86_400_000;
export const ARCHIVE_AFTER_MS = 14 * DAY_MS;
export const ARCHIVE_KEEP_MS = 30 * DAY_MS;

type Row = { state: ApplicationState; hiddenAt: number | null; createdAt: number };

/** When the row was (or will be) archived: hidden by the applicant, else 14 days after it was created. */
export const archivedAt = (app: Row) => app.hiddenAt ?? app.createdAt + ARCHIVE_AFTER_MS;

/** Rows mid-submission are never auto-archived: the employer may already have them. listRuns mirrors this in SQL. */
export const IN_FLIGHT_STATES: ApplicationState[] = ['submitting', 'submission_unknown'];

export function bucket(app: Row, now: number): 'action' | 'applied' | 'archived' | null {
  if (app.hiddenAt === null && app.state === 'submitted') return 'applied';
  if (app.hiddenAt === null && IN_FLIGHT_STATES.includes(app.state)) return 'action';
  const at = archivedAt(app);
  if (at > now) return 'action';
  return now - at < ARCHIVE_KEEP_MS ? 'archived' : null;
}

/** Open questions by application, each once: a reopened question has one notification per time it was asked. */
export function openQuestions<Q extends { id: string; resolved: boolean }>(items: { applicationId: string; question: Q | null }[]) {
  const asked = new Map<string, Q[]>();
  for (const { applicationId, question } of items) {
    const here = asked.get(applicationId) ?? [];
    if (question && !question.resolved && !here.some((item) => item.id === question.id)) asked.set(applicationId, [...here, question]);
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
