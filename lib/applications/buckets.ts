// Client-safe: which Auto Apply list a row belongs in. Archiving only hides; it never changes the application.
const DAY_MS = 86_400_000;
export const ARCHIVE_AFTER_MS = 14 * DAY_MS;
export const ARCHIVE_KEEP_MS = 30 * DAY_MS;

type Row = { state: string; hiddenAt: number | null; createdAt: number };

/** When the row was (or will be) archived: hidden by the applicant, else 14 days after it was created. */
export const archivedAt = (app: Row) => app.hiddenAt ?? app.createdAt + ARCHIVE_AFTER_MS;

export function bucket(app: Row, now: number): 'action' | 'applied' | 'archived' | null {
  if (app.hiddenAt === null && app.state === 'submitted') return 'applied';
  const at = archivedAt(app);
  if (at > now) return 'action';
  return now - at < ARCHIVE_KEEP_MS ? 'archived' : null;
}
