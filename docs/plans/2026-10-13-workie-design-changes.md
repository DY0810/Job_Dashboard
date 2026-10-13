# Workie design changes (2026-10-13)

Source: DY's design notes (header, Jobs, Auto Apply, Profile, Workers, Settings, Account).
Design authority: `.impeccable.md` (instrument-dense, OKLCH, hue 75, one accent = _fresh_ only,
three animations total). Also apply the taste-skill AI-tell bans: no em dashes in new UI copy,
no gradient text, no side-stripe borders (`border-left` > 1px), no generic shadows, no emoji.

Decisions already made with DY:

- Daily start is a **real schedule**: the paired worker's run is started by the server each day at a set time.
- Auto-archive after 14 days in Needs action is **hide only** (no cancel). Archived items vanish 30 days after archiving.
- Rows are append-only (no-delete trigger), so "deleted" means filtered out of every list, never a SQL DELETE.

Verification: `npm test`, `npx tsc --noEmit`, `npm run lint`. Browser checks happen at the end
by the controller (dev server config `redesign-dev`).

---

## Task 1: Shared primitives (badges, modal, posting URL)

1. **Status badges.** Add a `StatusBadge` component (`app/status-badge.tsx`) and CSS in
   `app/globals.css`. One badge per distinct meaning; each gets its own hue at low chroma
   (OKLCH, tinted like the rest of the palette) plus a small leading glyph so meaning never
   rides on color alone. Never the amber accent (accent = fresh only). Required tones/labels:
   - `queued` (neutral), `in progress` (screening/tailoring/filling/ready/submitting),
     `needs answer`, `needs document`, `needs approval` (submit_approval),
     `needs login`, `needs verification`, `retry` (provider_unavailable/retryable_failure),
     `unsupported` (blocked_unsupported), `unknown` (submission_unknown), `applied`
     (submitted), `failed`, `skipped`, `cancelled`, `archived`.
   - Export `statusBadge(state, reasonCode)` → `{ tone, label }` mapping from
     `lib/applications/state.ts` states. Put the pure mapping in `lib/applications/badges.ts`
     with a small vitest test.
   - Also export a `CountBadge` (small tabular-nums pill for tab counts).
   - Both themes tuned (light + dark tokens, including `[data-theme]` overrides).
2. **Modal.** `app/modal.tsx`: native `<dialog>` opened with `showModal()`, centered, titled,
   close button (X icon) + Esc + backdrop click close, focus returns to opener. Reuse the
   existing `--scrim`. Enter: opacity + scale 0.98→1, 160ms, `cubic-bezier(0.32,0.72,0,1)`;
   reduced motion → opacity only. Props: `open`, `onClose`, `title`, `children`, optional `footer`.
3. **Side drawer shell.** `app/side-drawer.tsx`: same as Modal but anchored right
   (reuse the jobs `Drawer` motion tokens from `.impeccable.md`: 220ms in / 165ms out,
   translateX + opacity). Used by Settings.
4. **Posting URL helper.** Move the ATS→URL mapping from `returnedPostingUrls` in
   `lib/applications/runs.ts` into a client-safe `lib/applications/posting-url.ts`:
   `postingUrl(ats, tenant, requisition): string | null` (canonical public job-post URL;
   greenhouse → `https://job-boards.greenhouse.io/{t}/jobs/{r}`, ashby, lever incl. eu).
   `returnedPostingUrls` keeps its exact output (both greenhouse hosts, lowercase) by using it.
   Add a test.

## Task 2: Header, Settings drawer, Workers under Settings, no Account

1. **One header everywhere.** Make a single `AppHeader` used by `PrivateShell`
   (`app/private-shell.tsx`), the board (`app/page.tsx`), `app/loading.tsx`, and the
   not-configured state. Identical on every page. Left: brand + nav (Jobs, Auto Apply,
   Profile, Notes). Right, in order: refresh icon, theme icon, settings icon, applicant switcher.
   - Remove `Workers`, `Settings`, `Account` from `app/app-nav.tsx`.
   - Remove the "Updated Xm ago" text from the header; move it into the board summary line
     (`board-summary` in `app/page.tsx`).
2. **Theme toggle** (`app/theme-toggle.tsx`): an icon button styled exactly like the refresh
   button (`chip app-icon-button`). Sun/Moon (lucide). Click flips light↔dark, stores in
   `localStorage['workie-theme']`. Initial icon reflects the effective theme (stored value, else
   `prefers-color-scheme`). `aria-label`/`title` = "Switch to dark theme"/"Switch to light theme".
3. **Applicant switcher** (`app/applicant-switcher.tsx`): drop the visible "Applicant" text; keep
   the `aria-label`. Style the select with the polished select treatment from Task 4.
4. **Refresh icon on every page.** On `/` it runs the ingest cycle as today. Elsewhere it
   dispatches `window.dispatchEvent(new Event('workie:refresh'))`; private pages listen
   (Auto Apply reloads its data). Hosted flag: pass from server via the header.
5. **Settings icon** (lucide `Settings`) opens a right **side drawer** (Task 1 shell), state in
   the URL: `?settings=1` on the current path (Link, `scroll={false}`); closing removes it.
   Drawer content (client, loads only when open):
   - **Auto Apply** section: daily start time control (from Task 3), "Start auto apply now"
     (move `StartPanel` logic from `app/applications/applications.tsx` here), policy enabled
     state + link to Profile policy.
   - **Workers** section: the existing Workers UI (`app/workers/workers.tsx`) embedded. Keep
     its behavior (pairing, revoke, polling, nav guard); drop its own `h1`/email/Refresh toolbar
     inside the drawer (the drawer has the title, header refresh covers refresh). Keep the
     "Import browser marks" link.
   - **Provider / Budget / Privacy**: the existing `app/settings/settings.tsx` sections,
     condensed (no duplicated email, no Refresh button, no "Manage workers" link).
   - `/settings` and `/workers` pages: `redirect('/applications?settings=1')`.
6. Sign-in page stays (locked states still link to it); only the nav entry goes away.

## Task 3: Backend: daily schedule + archive fields

1. **Daily start schedule (per worker).** Migration `drizzle-private/0011_*`: add
   `daily_start_minute integer` (0..1439, nullable) and `time_zone text` (IANA, nullable) to
   `private_worker`; update `lib/private-db/worker-schema.ts` and drizzle meta via
   `npm run db:private:generate` (check what that produces; hand-write only if generation fails).
   - Browser endpoint: `PATCH /api/workers/[id]` with `{ dailyStart: "HH:MM" | null, timeZone }`
     through the existing `browserWorkerEndpoint` pattern in `lib/applications/worker-http.ts`
     (owner-scoped, revision-checked like other worker commands). Validate time zone with
     `Intl.DateTimeFormat(undefined, { timeZone })`.
   - `WorkerListSchema` items gain `dailyStartMinute: number|null`, `timeZone: string|null`.
   - In `pollWorker` (`lib/applications/leases.ts`), before leasing: if the worker has a
     schedule, today's start instant (in its time zone) has passed, the owner's policy is
     enabled, no run of this worker is `running`, and no run of this worker was created at or
     after today's start instant → create a run exactly like `createRun` does (shared internal
     helper, no duplicated insert). Unit test the "is it due" function with fixed clocks across
     a DST change; put it in a pure module.
2. **Archive fields.** `ApplicationSummarySchema` gains `createdAt: number` and
   `hiddenAt: number|null`; `applicationSummary` fills them. `listRuns` returns hidden rows whose
   `hiddenAt > now - 30 days` (keep the limit). Pure `lib/applications/buckets.ts`:
   `bucket(app, now): 'action' | 'applied' | 'archived' | null` where
   - `applied` = `submitted`;
   - `archived` = `hiddenAt` set, or an `action` row older than 14 days (`createdAt + 14d <= now`);
     the archive moment is `hiddenAt ?? createdAt + 14d`, and `null` (gone) once that is
     30+ days ago;
   - `action` = everything else (waiting, failed, queued, in progress).
     Test it.

## Task 4: Jobs page

1. **Dropdowns.** Clicking the chevron must open the select: `pointer-events: none` on the
   icon, ChevronDown instead of ChevronRight, select fills the box. Polish: consistent height
   with chips, 1px rule border, hover/focus-visible ring, right padding for the chevron,
   `appearance: none`, tabular nums. Applies to every `.select-box` (seen filter, applicant switcher).
2. **One filter button.** Replace `filter`, `clear`, `save defaults`, `my defaults` with a single
   button in `app/filter-defaults.tsx`:
   - No saved filter yet: label `my filter`; click → setup mode, label becomes `save filter`;
     click again saves the current form selection and applies it.
   - Saved filter exists: `my filter` is a toggle (`aria-pressed`); on = URL matches saved,
     click when off applies saved, click when on clears to unfiltered.
   - If the current selection differs from the saved one while on, label becomes `save filter`
     (click saves the new selection).
   - Only one saved filter (existing `workie-default-filters` key). Keep a hidden submit button
     for no-JS. Remove the visible `filter` and `clear` buttons; the `NoMatches` state keeps
     its own `clear` link.
3. **No full-page reload on filter changes.** `app/auto-apply.tsx` intercepts `submit`:
   `preventDefault`, build the GET URL from `FormData`, `router.push(url, { scroll: false })`
   inside `startTransition`. Header, title, and filters must stay mounted; only the results
   area updates (dim it with `aria-busy` while pending). If `app/loading.tsx` replaces the page
   on search-param navigations, restructure so it does not (e.g. wrap only the results in a
   `<Suspense>` keyed by the query and keep `loading.tsx` for first load). Verify in browser.
4. **Pagination.** Centered: `‹  page X of Y  ›` with chevron icon buttons on both sides
   (disabled, not hidden, at the ends). Needs a total count: add `countPostings` in
   `lib/query.ts` using the same filters as `listPostings` (one extra `count(*)` query,
   run in the existing `Promise.all`). Always shown when Y > 1.
5. **Band gap.** 6px of space below each band divider row (`last 24 hours`, `earlier`).

## Task 5: Auto Apply page (`app/applications/applications.tsx`)

1. Header row: `h1` "Auto Apply" followed inline by state counts as status badges
   (e.g. `1 filling · 5 needs answer · 14 queued`, only non-zero, action-relevant states).
   Remove the email and the Refresh button (listen for `workie:refresh` instead).
   Right-aligned icons: Archived (lucide `Archive`, toggles `?view=archived`) and Settings
   (opens the Task 2 drawer via `?settings=1`). Under the header, one muted line:
   `Starts daily at 9:00 AM` (from the first non-revoked worker with a schedule) or
   `No daily start set` + link to the drawer.
2. Tabs: `Needs action` / `Applied`, each with a `CountBadge`. State in URL (`?view=action|applied|archived`).
   Archived view lists archived items with a note: "Archived items are removed 30 days after archiving."
   Use `bucket()` from Task 3.
3. Cards in a two-column grid (`repeat(auto-fit, minmax(360px, 1fr))`, one column on narrow
   screens). Card = 1px rule outline, no shadow. Title format `Company / Position`
   (company in fg, `/` in fg-dim, position fg). Status badge next to the title.
   Remove the ATS name and receipt/requisition code. Applied cards show "Applied {date}".
4. Issue detail (reason, question text, document help, queued explanation) inside its own
   1px outlined box within the card.
5. Action buttons right-aligned at the card bottom: contextual action(s) + always `Archive`
   (replaces Delete; same `delete` command; confirm copy says archive). Contextual:
   `Answer` (needs_answer / policy decision questions), `Upload` (document holds),
   `Approve` (submit approval), `Retry` (restartable/safe retry), `Open job post`
   (external link via `postingUrl`, for every card that has one), `Email recruiter` when an
   outreach draft is unsent. Archive hidden for `submitting`/`submission_unknown` (server rejects).
6. Clicking an action button opens the centered **Modal** (Task 1) with the action UI:
   question form (`QuestionForm` via the existing inbox control), document upload
   (`DocumentsPane` + Retry), approve (materials preview + Apply), outreach form, materials.
   Never open the inbox drawer. Close the modal after a successful action and reload.
7. Queued items keep the "starts on its own, up to N per employer and M a day" note in the box.

## Task 6: Profile (`app/profile/profile-editor.tsx`, `fields.tsx`, `profile.module.css`)

1. Remove the "Unsaved drafts" block and the revision number from the status line
   (status reads `Saved` / `Saving...` / ...). Add a toolbar icon button "Drafts" (lucide
   `History`) with a count badge; opens a Modal listing recoverable drafts
   (`Draft N`, `base revision R`, Recover) and the current revision; empty state when none.
2. Not an endless scroll: only the selected section renders. Sidebar items switch the section
   (URL hash `#section`, default first section, back button works). Active item marked with
   `aria-current`, plus a clear hover state on every item.
3. Remove the `Details` `<details>` block from `FactField`.
4. Replace the "Import from a resume extraction" `<details>` with a toolbar button
   `Upload new resume` that opens a Modal containing `DocumentsPane` with
   `initialKind="resume_master"`.
5. Remove the answer-state `<select>` (Not answered / Decline / ...). Any value entered sets
   `confirmed`; clearing sets `unknown`. A `candidate` fact shows a `candidate` badge and a
   small `Confirm` button.
