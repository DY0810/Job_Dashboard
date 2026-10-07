# DY / May Feature Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or work the checkboxes in order to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Auto Apply, recruiter email, applied-role recording and profile saving work for both household applicants (DY `household-dy-v1`, May `household-may-v1`) without one applicant's data or worker leaking into the other's.

**Architecture:** Three small code changes (per-applicant board checks; a pairing owner precondition; an opt-in policy action that sends verified recruiter email without Send) on a branch off `origin/main` (diagnosed at `a506a25`; none of these files changed through `9ee523b`), then three operator runbooks that only a human can finish (re-pair DY's worker, add a recruiter-lookup key, start May's run).

**Tech Stack:** Next.js 15 App Router, TypeScript, Vitest, Node 22 worker (`node --test` checks), Drizzle over libSQL/Turso, Vercel.

---

## Diagnosis (2026-10-07, origin/main `a506a25`)

| Feature                     | DY                                                                                                                                                                                 | May                                                                                                                                             | Root cause                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Auto Apply                  | **Down.** Both DY workers revoked 2026-10-06 00:39 PDT; `runnerAvailable: false`; run `31e85aae` paused. Code path works: 5 real Greenhouse submissions with receipts (Sep 26–27). | Worker `593c59f8` online, policy rev 12 enabled, but no run active (all 3 stopped after tests). Verified through filling, never through submit. | During May's pairing on 10/6 the grant was created while **DY** was the active applicant, so May's worker registered under DY as "May_Apply / 20846626". Cleaning that up revoked DY's real worker `48a55ab4` too. `pairWorker` cannot refuse: the pair request carries no expected owner, and the CLI only notices the mismatch (`BINDING_CHANGED`) after the server has consumed the grant and registered the worker.                                |
| Auto Apply coverage (both)  | Only Greenhouse works on live forms                                                                                                                                                | Same                                                                                                                                            | `worker/ats/{ashby,lever,workday,jobvite,oracle,icims}.ts` only match `form[data-ats="…"]`, which exists only in the synthetic fixtures. Greenhouse is roughly 12% of live engineering internships and 25% of live design postings (local snapshot, Aug 28).                                                                                                                                                                                           |
| Recruiter email             | 2 drafts, both `no_recipient`; nothing has ever been sent                                                                                                                          | No drafts (nothing submitted)                                                                                                                   | Production has no `WORKIE_HUNTER_API_KEY` / `WORKIE_FINDYMAIL_API_KEY`, so `findRecipient` (`lib/applications/outreach.ts:77`) makes zero lookups and returns null unless the posting itself lists an address. Also by design (201d9c1) every email waits for the applicant's **Send**; the cron only sends what was approved. Task 3 adds an opt-in policy action to skip Send.                                                                                                                         |
| Recording applied roles     | Worker submissions recorded (`submitted` + receipt).                                                                                                                               | Same code. No `APPLIED-May.md` ledger yet (needs May's confirmation emails).                                                                    | Board "applied" checks are stored as `workie-applied:<postingId>` in `localStorage`, **not per applicant**. `syncApplied` (`app/applied-sync.tsx:15`) reports every check in the browser to whichever applicant is active. DY and May share this Mac's browser, so after a switch DY's checks become May's permanent server marks and vice versa (repro below). This Mac's built-in browser held no checks on 10/7, so nothing has leaked from it yet. |
| Saving personal information | Works (profile rev 22)                                                                                                                                                             | Works (profile rev 17)                                                                                                                          | No bug. Every profile request is owner-checked. May's disclosures section is just unanswered.                                                                                                                                                                                                                                                                                                                                                          |

Repro for the applied-check leak (red on `a506a25`):

```
✗ does not report DY's checks to May after the applicant switches in the same browser
  + { "ids": [12], "owner": "household-may-v1" }   ← DY's check imported as May's
```

Test suites on clean `a506a25`: `npx vitest run --exclude '.claude/**'` → 1775/1775 pass; `npm run test:worker` → 102/102 pass. Plain `npx vitest run` shows 25 false failures because it also collects `.claude/worktrees/design-review/**` (Task 4 fixes this).

**Not in this plan (need a decision or their own spec):**

- Live Ashby/Lever/Workday adapters. Each needs live-form qualification per `docs/auto-apply-support.md` and is its own plan.
- Showing server-side marks (worker submissions, imports) as checked on the board. Add it when someone misses it.

---

## File map

| File                                     | Change                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------- |
| `app/board-storage.ts`                   | `appliedKey/readApplied/saveApplied` take the applicant (`owner`)                           |
| `app/board-storage.test.ts`              | updated calls, plus one isolation assertion                                                 |
| `app/applied-sync.tsx`                   | sync only the active applicant's checks; move already-reported old checks to that applicant |
| `app/applied-sync.test.ts`               | owner-switch and move regression tests                                                      |
| `app/applied-checkbox.tsx`               | resolve the active applicant once per page; read and write that applicant's key             |
| `lib/applications/worker-protocol.ts`    | optional `expectedOwnerId` on `PairRequestSchema`                                           |
| `lib/applications/pairing.ts`            | refuse a grant for another owner before registering                                         |
| `lib/applications/worker-server.test.ts` | regression test                                                                             |
| `worker/pairing.ts`                      | send `expectedOwnerId`; forget a refused grant so the next `pair` asks again                |
| `worker/runtime.check.mjs`               | assert both                                                                                 |
| `lib/applications/policy.ts`             | new opt-in action `auto_send_recruiter_email`                                               |
| `lib/applications/outreach.ts`           | queue a verified draft without Send when that action is on; un-queue when it goes off       |
| `lib/applications/outreach.test.ts`      | regression tests                                                                            |
| `docs/auto-apply-workflow.md`            | one sentence                                                                                |
| `vitest.config.ts`                       | exclude `.claude/**`                                                                        |

---

### Task 0: Worktree

The main checkout `/Users/dyl/Workie` is shared with other Claude sessions. Work in a worktree.

- [x] **Step 1: Create it and bring this plan along** (done 2026-10-07 06:19: `.claude/worktrees/dy-may-fixes` on `fix/dy-may-applicant-isolation` at `9ee523b`; skip this command)

```bash
cd /Users/dyl/Workie && git fetch origin && git worktree add .claude/worktrees/dy-may-fixes -b fix/dy-may-applicant-isolation origin/main && ln -s /Users/dyl/Workie/node_modules .claude/worktrees/dy-may-fixes/node_modules && cp docs/plans/2026-10-07-dy-may-feature-fixes.md .claude/worktrees/dy-may-fixes/docs/plans/
```

All later paths are relative to `/Users/dyl/Workie/.claude/worktrees/dy-may-fixes`.

---

### Task 1: Board "applied" checks belong to one applicant

**Files:**

- Modify: `app/board-storage.ts:6-33`
- Modify: `app/applied-sync.tsx:1-42`
- Modify: `app/applied-checkbox.tsx:1-55`
- Test: `app/applied-sync.test.ts`, `app/board-storage.test.ts`

- [ ] **Step 1: Write the failing tests**

In `app/applied-sync.test.ts`:

1. Add `import { readApplied, saveApplied } from './board-storage';` under the existing imports.
2. Give `storage()` a `removeItem`, which `saveApplied` and the sync now use:

```ts
function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
}
```

3. Let `server()` switch applicant:

```ts
function server(signedIn = true, who = { id: "dy" }) {
  const calls: {
    path: string;
    owner: string | null;
    body: Record<string, unknown> | null;
  }[] = [];
  const request = (async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({
      path,
      owner: new Headers(init?.headers).get("x-workie-applicant"),
      body,
    });
    if (path === "/api/auth/applicant")
      return signedIn
        ? Response.json({ ownerId: who.id })
        : new Response(null, { status: 401 });
    if (path.endsWith("/preview"))
      return Response.json({ previewToken: "token-1", previewHash: "hash-1" });
    return Response.json({ status: "manual_reported" });
  }) as typeof fetch;
  return { calls, request };
}
```

4. In the first existing test, scope the keys to `dy`: `'workie-applied:dy:12': '1', 'workie-applied:dy:7': '1', 'workie-applied:dy:9': '0'`, and `store.setItem('workie-applied:dy:30', '1')`. Leave the signed-out and empty tests as they are.

5. Add these two tests inside the `describe`:

```ts
it("reports a check only to the applicant who made it, and shows it only to them", async () => {
  const store = storage({});
  const who = { id: "dy" };
  const { calls, request } = server(true, who);
  saveApplied(12, true, "dy", store);
  expect(await syncApplied(store, request)).toBe(1);
  who.id = "may"; // same browser, May picked in the Applicant menu (the page reloads)
  expect(await syncApplied(store, request)).toBe(0);
  expect(readApplied(12, "may", store)).toBe(false);
  saveApplied(7, true, "may", store);
  expect(await syncApplied(store, request)).toBe(1);
  expect(
    calls
      .filter((call) => call.path.endsWith("/confirm"))
      .map((call) => [call.owner, call.body!.postingIds]),
  ).toEqual([
    ["dy", [12]],
    ["may", [7]],
  ]);
});

it("moves an old unscoped check to the applicant it was already reported to, and lets them untick it", async () => {
  const store = storage({
    "workie-applied:12": "1",
    "workie-applied-synced": '["dy:12"]',
  });
  const who = { id: "may" };
  const { calls, request } = server(true, who);
  expect(await syncApplied(store, request)).toBe(0);
  expect(readApplied(12, "may", store)).toBe(false);
  who.id = "dy";
  expect(await syncApplied(store, request)).toBe(0);
  expect(readApplied(12, "dy", store)).toBe(true);
  expect(store.getItem("workie-applied:12")).toBeNull();
  saveApplied(12, false, "dy", store);
  await syncApplied(store, request);
  expect(readApplied(12, "dy", store)).toBe(false);
  expect(calls.some((call) => call.path.endsWith("/confirm"))).toBe(false);
});
```

In `app/board-storage.test.ts`, pass `null` (signed out) as the new owner argument and add one isolation check:

```bash
sed -i '' -E 's/readApplied\(([0-9]+), /readApplied(\1, null, /g; s/saveApplied\(([0-9]+), (true|false), /saveApplied(\1, \2, null, /g' app/board-storage.test.ts
```

Then, after `expect(readApplied(12, null, storage)).toBe(false);` (the line after `storage.setItem(appliedKey(12), 'invalid');`), add:

```ts
expect(saveApplied(12, true, "dy", storage)).toBe(true);
expect(readApplied(12, "dy", storage)).toBe(true);
expect(readApplied(12, "may", storage)).toBe(false);
expect(readApplied(12, null, storage)).toBe(false);
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run app/applied-sync.test.ts app/board-storage.test.ts`
Expected: FAIL. The new sync tests import DY's check as May's (or see 0 reported because the old `saveApplied` takes the owner as its store), and the owner isolation assertion fails.

- [ ] **Step 3: Scope the storage keys** — `app/board-storage.ts`, replace `appliedKey`, `readApplied`, `saveApplied`:

```ts
/** Signed in, a check belongs to the applicant who made it; signed out it stays in this browser only. */
export const appliedKey = (id: number, owner: string | null = null) =>
  owner ? `workie-applied:${owner}:${id}` : `workie-applied:${id}`;

export function readApplied(
  id: number,
  owner: string | null,
  store: Store | null = localStore(),
): boolean {
  try {
    return store?.getItem(appliedKey(id, owner)) === "1";
  } catch {
    return false;
  }
}

export function saveApplied(
  id: number,
  applied: boolean,
  owner: string | null,
  store: Store | null = localStore(),
): boolean {
  try {
    if (!store) return false;
    if (applied) store.setItem(appliedKey(id, owner), "1");
    else store.removeItem(appliedKey(id, owner));
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Sync only the active applicant's checks** — `app/applied-sync.tsx`

Change the import to `import { APPLIED_EVENT, appliedKey } from './board-storage';` and the store type to `type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;`. Then replace the body of `syncApplied` up to (not including) `const post = …`:

```ts
export async function syncApplied(store: Store, request: typeof fetch = fetch, signal?: AbortSignal) {
  const ticked: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith('workie-applied:') && store.getItem(key) === '1') ticked.push(key);
  }
  if (!ticked.length) return 0;
  const init = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal } as const;
  const account = await request('/api/auth/applicant', init);
  if (!account.ok) return 0;
  const { ownerId } = await account.json() as { ownerId: string };
  let synced: string[] = [];
  try { synced = JSON.parse(store.getItem(SYNCED) ?? '[]'); } catch { /* resend; confirming a mark twice is harmless */ }
  const prefix = `workie-applied:${ownerId}:`, checked: number[] = [];
  let moved = false;
  for (const key of ticked) {
    // A check from before checks were per applicant moves to the applicant it was already reported to.
    const legacy = /^workie-applied:([1-9]\d*)$/.exec(key)?.[1];
    if (legacy && synced.includes(`${ownerId}:${legacy}`)) {
      store.setItem(appliedKey(Number(legacy), ownerId), '1');
      store.removeItem(key);
      moved = true;
    }
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (/^[1-9]\d*$/.test(id)) checked.push(Number(id));
  }
  // Same-tab storage writes fire no event; tell the rows to re-read.
  if (moved && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APPLIED_EVENT));
  const pending = checked.filter((id) => !synced.includes(`${ownerId}:${id}`)).slice(0, 1000);
  if (!pending.length) return 0;
```

Replace the doc comment above it with:

```ts
/**
 * Reports the active applicant's board "applied" checks to their auto-apply, which then never applies
 * to those jobs. It reuses the import preview/confirm endpoints. Server marks are permanent, so
 * unchecking stays in this browser. Checks are stored per applicant because DY and May share a browser.
 * Unscoped checks (signed out, or from before this change) are never reported automatically; the
 * Applications page import can still report them on purpose.
 */
```

- [ ] **Step 5: Run the tests and watch them pass**

Run: `npx vitest run app/applied-sync.test.ts app/board-storage.test.ts`
Expected: PASS, all tests.

- [ ] **Step 6: Make the checkbox read and write the active applicant's key** — `app/applied-checkbox.tsx`

Above `export function AppliedCheckbox`:

```ts
// One request per page for every row; switching applicant reloads the page.
let ownerRequest: Promise<string | null> | undefined;
const activeOwner = () =>
  (ownerRequest ??= fetch("/api/auth/applicant", {
    credentials: "same-origin",
    cache: "no-store",
  })
    .then(async (response) =>
      response.ok
        ? ((await response.json()) as { ownerId: string }).ownerId
        : null,
    )
    .catch(() => null));
```

Replace the state and effect (the checkbox stays disabled until the owner is known, as it already does until `ready`):

```tsx
const [applied, setApplied] = useState(false);
const [owner, setOwner] = useState<string | null>(null);
const [ready, setReady] = useState(false);
const [error, setError] = useState(false);

useEffect(() => {
  let current: string | null = null;
  let live = true;
  const update = () => setApplied(readApplied(postingId, current));
  const storage = (event: StorageEvent) => {
    if (event.key === null || event.key === appliedKey(postingId, current))
      update();
  };
  const changed = (event: Event) => {
    // No detail (null): the sync moved old checks, so every row re-reads.
    const detail = (event as CustomEvent<number | null>).detail;
    if (detail == null || detail === postingId) update();
  };
  void activeOwner().then((resolved) => {
    if (!live) return;
    current = resolved;
    setOwner(resolved);
    update();
    setReady(true);
  });
  window.addEventListener("storage", storage);
  window.addEventListener(APPLIED_EVENT, changed);
  return () => {
    live = false;
    window.removeEventListener("storage", storage);
    window.removeEventListener(APPLIED_EVENT, changed);
  };
}, [postingId]);
```

and in `onChange`: `const saved = saveApplied(postingId, next, owner);`

- [ ] **Step 7: Type-check and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. `readApplied`/`saveApplied` have no other callers (`grep -rn "readApplied\|saveApplied" app lib tests`). `readLegacyMarks` and `tests/discovery-ui` use the unscoped key and are unaffected.

- [ ] **Step 8: Commit**

```bash
git add app/board-storage.ts app/board-storage.test.ts app/applied-sync.tsx app/applied-sync.test.ts app/applied-checkbox.tsx
git commit -m "Keep each applicant's board applied checks their own

A check was stored per browser and reported to whichever applicant was
active, so after switching between DY and May on one Mac each one's checks
became the other's permanent applied marks.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The browser check happens after deploy (Task 4, Step 4): no local dev server here can sign in as DY or May.

---

### Task 2: A worker set up for one applicant never takes another's pairing grant

**Files:**

- Modify: `lib/applications/worker-protocol.ts:26-29`
- Modify: `lib/applications/pairing.ts:41`
- Modify: `worker/pairing.ts:1-6,49-55`
- Test: `lib/applications/worker-server.test.ts`, `worker/runtime.check.mjs`

- [ ] **Step 1: Write the failing tests**

In `lib/applications/worker-server.test.ts`, inside `describe('hashed owner-approved pairings', …)`:

```ts
it("refuses a grant made for another applicant before registering or consuming it", async () => {
  const grant = await createPairing(
    db,
    "alice",
    { ...revision(0), expectedRevision: 0, label: "Set up for Bob" },
    options,
  );
  const input: p.PairRequest = {
    protocolVersion: 1,
    workerId: randomUUID(),
    requestId: randomUUID(),
    grant: grant.grant,
    workerToken: secret(),
    workerVersion: "0.1.0",
    capabilities: ["control-v1"],
  };
  await expect(
    pairWorker(db, { ...input, expectedOwnerId: "bob" }, options),
  ).rejects.toMatchObject({ status: 409, code: "OWNER_MISMATCH" });
  expect((await listWorkers(db, "alice", options)).workers).toEqual([]);
  // The grant still works for the applicant it was made for.
  await expect(
    pairWorker(db, { ...input, expectedOwnerId: "alice" }, options),
  ).resolves.toMatchObject({ ownerId: "alice" });
});
```

In `worker/runtime.check.mjs`, in the test "pairing saves credential before registration…", after `assert.deepEqual(calls[0], calls[1]);` add:

```js
assert.equal(calls[0].expectedOwnerId, s.ownerId);
```

and add a new test after it:

```js
test("a refused grant is forgotten so the next pair asks for a new one", async () => {
  const s = scope(),
    store = await storeFor(s),
    vault = credentials(s, backend());
  let prompts = 0;
  const readGrant = async () => {
    prompts++;
    return "G".repeat(43);
  };
  await assert.rejects(
    pairWorker({
      scope: s,
      store,
      vault,
      readGrant,
      transport: {
        pair: async () => {
          throw new TransportError("HTTP_409", 409);
        },
      },
    }),
    /HTTP_409/,
  );
  assert.equal(vault.get("worker"), null);
  await pairWorker({
    scope: s,
    store,
    vault,
    readGrant,
    transport: { pair: async () => pairResponse(s) },
  });
  assert.equal(prompts, 2);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/applications/worker-server.test.ts -t "another applicant"; node --test worker/runtime.check.mjs`
Expected: vitest FAILs, because the strict schema rejects the unknown `expectedOwnerId` with a ZodError, not `OWNER_MISMATCH`. The runtime check FAILs twice: `undefined !== 'synthetic-owner-a'`, and the refused grant is still saved (`vault.get("worker")` is not null).

- [ ] **Step 3: Add the precondition to the protocol** — `lib/applications/worker-protocol.ts`:

```ts
export const PairRequestSchema = z.strictObject({
  ...protocol,
  requestId: uuid,
  workerId: uuid,
  grant: secret,
  workerToken: secret,
  workerVersion: z.string().regex(/^[a-zA-Z0-9.+_-]{1,40}$/),
  capabilities,
  // A precondition, never authority: the grant alone decides the owner. Optional so a worker built before it still pairs.
  expectedOwnerId: z.string().min(1).max(256).optional(),
});
```

- [ ] **Step 4: Refuse before anything is written** — `lib/applications/pairing.ts`, right after `if (!pairing || pairing.revokedAt !== null) fail(401, 'WORKER_UNAUTHORIZED', 'Invalid pairing grant.');`:

```ts
// A worker set up for one applicant must not consume, or register under, another applicant's grant.
if (
  command.expectedOwnerId !== undefined &&
  command.expectedOwnerId !== pairing.ownerId
) {
  fail(
    409,
    "OWNER_MISMATCH",
    "This pairing grant was created for a different applicant.",
  );
}
```

- [ ] **Step 5: Send it from the worker, and forget a refused grant** — `worker/pairing.ts`

Add `import { TransportError } from "./transport.ts";` and change the existing `import type { WorkerTransport } from "./transport.ts";` to keep it. Then replace the `const response = PairResponseSchema.parse(await transport.pair({ … }, signal));` statement with:

```ts
let response;
try {
  response = PairResponseSchema.parse(
    await transport.pair(
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        requestId: metadata.requestId,
        workerId: scope.workerId,
        expectedOwnerId: scope.ownerId,
        workerVersion: metadata.workerVersion,
        capabilities: [...WORKER_CAPABILITIES],
        grant: credential.grant,
        workerToken: credential.workerToken,
      },
      signal,
    ),
  );
} catch (error) {
  // A definite refusal (another applicant's, expired or used grant) never registered anything:
  // drop the saved grant so the next `pair` asks for a new one. Network faults keep it to reconcile.
  if (
    error instanceof TransportError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 429].includes(error.status)
  ) {
    vault.remove("worker");
  }
  throw error;
}
```

Keep the existing `BINDING_CHANGED` check after it: a server without this change still answers with the grant's owner.

- [ ] **Step 6: Run the tests and watch them pass**

Run: `npx vitest run lib/applications/worker-server.test.ts; npm run test:worker`
Expected: PASS (worker: 103/103).

- [ ] **Step 7: Commit**

```bash
git add lib/applications/worker-protocol.ts lib/applications/pairing.ts lib/applications/worker-server.test.ts worker/pairing.ts worker/runtime.check.mjs
git commit -m "Refuse a pairing grant made for another applicant before registering

May's worker paired with a grant created while DY was active, registered
under DY, and the cleanup revoked DY's own worker. The worker now names the
owner it was set up for, and the server refuses a mismatch before it
consumes the grant. A refused grant is dropped from the keychain, so after
HTTP_409 the operator switches applicant, creates a new grant and runs
pair again.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Recruiter email sends itself only when the policy says so

Decided 2026-10-07: the applicant presses **Send** unless they turn automatic sending on in their policy. The new policy action `auto_send_recruiter_email` ("Auto send recruiter email" in the Profile → Auto Apply policy checkboxes; the form is generated from the schema, so it needs no UI code). Turning it on is a policy edit, and like `submit` (`lib/applications/runs.ts:141`) it acts only while the policy is enabled: Save without Enable, or Disable, stops it. Even when it is on, an email goes only to a verified recruiter (posting, Hunter or Findymail), never to a recruiter already emailed, and only in the draft's Tue–Thu window, at least 3 days after applying. A `no_recipient` draft still waits for the applicant. If automatic sending is turned off, emails it queued go back to waiting for Send.

**Files:**
- Modify: `lib/applications/policy.ts:28-29` and its `superRefine`
- Modify: `lib/applications/outreach.ts` (`Approval`, `State`, `fold`, `holdDisabled`, `deliver`, `sendDueOutreach`)
- Modify: `docs/auto-apply-workflow.md:304`
- Test: `lib/applications/outreach.test.ts`

- [ ] **Step 1: Write the failing tests** — `lib/applications/outreach.test.ts`

Change the import to `import { createEmptyPolicy, PolicySchema, type Policy } from './policy.ts';`. Above `describe('recruiter email after a verified submission', …)` add:

```ts
async function setActions(actions: Policy['actions'], version: number) {
  const policy: Policy = { ...createEmptyPolicy(), actions }, hash = hashValue(policy);
  await db.insert(policyVersions).values({ ownerId: 'alice', version, hash, policy, createdAt: now });
  await db.update(policyHeads).set({ revision: version, policyVersion: version, acceptedPolicyVersion: version, acceptedPolicyHash: hash })
    .where(eq(policyHeads.ownerId, 'alice'));
}
```

Inside the `describe`:

```ts
  it('sends a verified recruiter email in its window without Send only when the policy turns that on', async () => {
    expect(PolicySchema.safeParse({ ...createEmptyPolicy(), actions: ['auto_send_recruiter_email'] }).success).toBe(false);
    await setActions(['email_recruiters', 'auto_send_recruiter_email'], 2);
    const { token, app } = await application(), unknown = await application();
    const window = sendWindow(now);
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'scheduled', to: 'jobs@employer.test', source: 'posting', sendAfter: window });
    // No verified recruiter: still the applicant's call.
    expect(await recordOutreachDraft(db, unknown.token, unknown.app.id, draft(), options)).toMatchObject({ status: 'draft', reason: 'no_recipient' });
    expect(await sendDueOutreach(db, options)).toBe(0); // never on application day
    now = window;
    expect(await sendDueOutreach(db, options)).toBe(1);
    expect(sent.map((item) => item.to)).toEqual(['jobs@employer.test']);
  });

  it('puts an email the policy queued back to waiting for Send once automatic sending is off', async () => {
    await setActions(['email_recruiters', 'auto_send_recruiter_email'], 2);
    const { token, app } = await application();
    const queued = await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@employer.test'] }), options);
    await setActions(['email_recruiters'], 3);
    now = queued.sendAfter!;
    expect(await sendDueOutreach(db, options)).toBe(0);
    expect(sent).toEqual([]);
    expect((await listOutreach(db, 'alice', options)).outreach[0])
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'jobs@employer.test' });
    expect(await sendOutreach(db, 'alice', app.id, { to: 'jobs@employer.test', name: null, now: true }, options))
      .toMatchObject({ status: 'sent' });
  });

  it('sends nothing on its own while the policy is not enabled, like submit', async () => {
    await setActions(['email_recruiters', 'auto_send_recruiter_email'], 2);
    const first = await application(), second = await application();
    const queued = await recordOutreachDraft(db, first.token, first.app.id, draft({ emails: ['jobs@employer.test'] }), options);
    expect(queued).toMatchObject({ reason: 'scheduled' });
    await db.update(policyHeads).set({ enabled: false }).where(eq(policyHeads.ownerId, 'alice')); // Save without Enable, or Disable
    expect(await recordOutreachDraft(db, second.token, second.app.id, draft({ emails: ['campus@employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval' });
    now = queued.sendAfter!;
    expect(await sendDueOutreach(db, options)).toBe(0);
    expect(sent).toEqual([]);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run lib/applications/outreach.test.ts`
Expected: the three new tests FAIL. `setActions` stores an action the schema doesn't know, so `getPolicy` fails to parse it, or the draft holds as `awaiting_approval` instead of `scheduled`. The other tests still PASS.

- [ ] **Step 3: Add the policy action** — `lib/applications/policy.ts`

```ts
  // email_recruiters: after a verified submission, email a recruiter from your own Gmail asking for a chat.
  // auto_send_recruiter_email: send that email in its Tue–Thu window without waiting for Send (verified recruiters only).
  actions: z.array(z.enum(['read_jobs', 'tailor_documents', 'fill_forms', 'submit', 'email_recruiters', 'auto_send_recruiter_email'])).max(6),
```

and in `superRefine`:

```ts
  if (p.actions.includes('auto_send_recruiter_email') && !p.actions.includes('email_recruiters')) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Sending recruiter email automatically needs recruiter email on.' });
  }
```

Stored policies still parse: they only use the old values.

- [ ] **Step 4: Mark and fold an approval the policy made** — `lib/applications/outreach.ts`

```ts
type Approval = Recipient & { outreach: 'approval'; sendAfter: number; auto?: true };
…
type State = Omit<Outreach, 'contactedFor'> & { draft: Draft; attempts: number; autoApproved: boolean };
```

In `fold`, add to `base` (after `attempts: …`): `autoApproved: latest?.outreach === 'approval' && latest.auto === true`. `view` lists its fields explicitly, so this never reaches the API.

Give `holdDisabled` a reason:

```ts
/** Holds a queued email: recruiter email is off (Send again once it is back on), or automatic sending is off (press Send). */
async function holdDisabled(db: PrivateDb, ownerId: string, state: State, { to, name, title, source }: Recipient, now: number,
  reason = 'outreach_disabled') {
  await append(db, ownerId, state.applicationId, id(state.applicationId, 'hold', state.attempts, state.updatedAt, 'draft', reason, to),
    { kind: 'outreach', outreach: 'outcome', attempt: null, status: 'draft', reason, to, name, title, source }, now);
}
```

- [ ] **Step 5: Queue instead of holding when the policy says so** — in `deliver`, replace

```ts
    // Nothing is emailed on the applicant's behalf until they review the draft and press Send.
    if (!queued) return hold('draft', 'awaiting_approval', recipient);
```

with

```ts
    // Nothing is emailed on the applicant's behalf until they review the draft and press Send, unless their
    // policy sends it for them; then it still waits for the draft's Tue–Thu window, and the cron sends it.
    if (!queued) {
      const live = await getPolicy(db, ownerId, nowAt(options));
      // Like submit (runs.ts), only an enabled policy acts without a click.
      if (!live.enabled || !live.policy.actions.includes('auto_send_recruiter_email')) {
        return hold('draft', 'awaiting_approval', recipient);
      }
      await append(db, ownerId, applicationId, id(applicationId, 'approval', state.attempts, state.updatedAt, recipient.to),
        { outreach: 'approval', ...recipient, sendAfter: state.draft.sendAfter ?? sendWindow(nowAt(options), 0), auto: true }, nowAt(options));
      return view((await read())!);
    }
```

- [ ] **Step 6: Re-check the switch when the cron sends** — in `sendDueOutreach`, replace

```ts
      if (!await enabled(db, ownerId, now)) {
        await holdDisabled(db, ownerId, state, { to: state.to!, name: state.name, title: state.title, source: state.source! }, now);
        continue;
      }
```

with

```ts
      const { enabled: active, policy: { actions } } = await getPolicy(db, ownerId, now);
      const recipient: Recipient = { to: state.to!, name: state.name, title: state.title, source: state.source! };
      if (!actions.includes('email_recruiters')) { await holdDisabled(db, ownerId, state, recipient, now); continue; }
      // The policy queued it and automatic sending is off or the policy is disabled now: it waits for Send again.
      if (state.autoApproved && !(active && actions.includes('auto_send_recruiter_email'))) {
        await holdDisabled(db, ownerId, state, recipient, now, 'awaiting_approval');
        continue;
      }
```

`enabled` stays; `sendOutreach` still uses it.

- [ ] **Step 7: Run the tests and watch them pass**

Run: `npx vitest run lib/applications/outreach.test.ts && npx tsc --noEmit`
Expected: PASS, all outreach tests (old ones unchanged: with the action off, nothing sends without Send), and types clean.

- [ ] **Step 8: Update the doc** — `docs/auto-apply-workflow.md`, in "Recruiter email", after "Send now skips the wait." add: `With "Auto send recruiter email" on in the policy, a draft with a verified recipient is queued for that window without Send; turning it off puts those emails back to waiting for Send.`

- [ ] **Step 9: Commit**

```bash
git add lib/applications/policy.ts lib/applications/outreach.ts lib/applications/outreach.test.ts docs/auto-apply-workflow.md
git commit -m "Let an applicant's policy send verified recruiter email without Send

Off by default: the applicant still presses Send. With the new
auto_send_recruiter_email action on, a draft with a verified recruiter is
queued for its Tue-Thu window like an approved one; turning it off puts
those emails back to waiting for Send.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Full verification, PR, deploy check

- [ ] **Step 1: Stop vitest collecting other worktrees** — `vitest.config.ts`:

```ts
import { configDefaults, defineConfig } from "vitest/config";
…
  test: {
    // Phase 0 ships zero tests — the harness must be proven runnable, not faked with a
    // dummy test. Later phases add real suites; this stays true once they do.
    passWithNoTests: true,
    // Claude worktrees live inside the checkout; their copies of the suite are not this tree's.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
```

- [ ] **Step 2: Run everything**

Run: `npm test && npm run test:worker && npx tsc --noEmit && npm run lint && npm run build`
Expected: vitest all pass with 0 failures (6 more than before; under heavy machine load a real-process test such as `questions-http.test.ts` can time out, so rerun once before investigating), worker 103/103, and types, lint and build all clean.

- [ ] **Step 3: Commit, push and open the PR**

```bash
cp /Users/dyl/Workie/docs/plans/2026-10-07-dy-may-feature-fixes.md docs/plans/   # the worktree's copy predates later edits
git add vitest.config.ts docs/plans/2026-10-07-dy-may-feature-fixes.md
git commit -m "Leave Claude worktrees out of the vitest run; add the DY/May fix plan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin fix/dy-may-applicant-isolation
gh pr create --title "Keep DY's and May's applied checks and workers apart; opt-in recruiter auto-send" --body "Board applied checks are now per applicant, pairing refuses another applicant's grant, and a new policy action sends verified recruiter email without Send (off by default). Diagnosis: docs/plans/2026-10-07-dy-may-feature-fixes.md.

🤖 Generated with [Claude Code](https://claude.com/claude-code)"
```

Deploy rule: don't run `pair` from the new worker code until this is live on Vercel. The old strict schema would reject `expectedOwnerId` with HTTP_400. Workers that are already paired never call pair again, so May's running worker is unaffected.

After the PR merges, delete the untracked copy of this plan in the main checkout (`rm /Users/dyl/Workie/docs/plans/2026-10-07-dy-may-feature-fixes.md`), or `git pull` there refuses to overwrite it.

- [ ] **Step 4 (after deploy, DY in production):** On the board signed in as DY, tick a posting **DY has already applied to**. Any tick becomes a permanent server mark, and Auto Apply never applies to that job. Wait 5 s. `localStorage` should hold `workie-applied:household-dy-v1:<id>`, and the network log should show one `/api/applications/import/confirm` with `x-workie-applicant: household-dy-v1`. Switch to May: the row is unticked and no confirm is sent. Switch back to DY.

---

### Task 5 (operator, DY): Re-pair DY's worker

Only DY can do steps 2–4: Claude never handles grants or API keys. Run this on the machine that runs DY's worker, after Task 4 is deployed.

- [ ] **Step 1:** Workie → Applicant **DY** → `/workers` → **Create pairing grant**.
- [ ] **Step 2:** In a fresh terminal (new directory, because the old `~/.local/share/workie-worker` is still marked paired to the revoked worker `48a55ab4`, so `pair` would no-op and `start` would get 401):

```bash
cd ~/Workie && git pull && export WORKIE_WORKER_ORIGIN=https://job-dashboard-one-sigma.vercel.app WORKIE_WORKER_OWNER=household-dy-v1 WORKIE_WORKER_DIRECTORY="$HOME/.local/share/workie-worker-dy" && umask 077 && mkdir -p "$WORKIE_WORKER_DIRECTORY" && npm run worker -- pair
```

DY presses **Copy grant** and pastes it at the hidden prompt. If it prints `HTTP_409`, the grant was made under May: switch to DY, create a new grant and run `pair` again; it asks for the grant again.

- [ ] **Step 3:** `WORKIE_PROVIDER_ID=byok:compatible npm run worker -- set-provider-key` (DY pastes his key), then `npm run worker -- start`.
- [ ] **Step 4:** `/workers` shows the new worker Online. Press **Create run**: the paused run `31e85aae` is bound to the revoked worker.
- [ ] **Step 5 (verify):** in the Workie tab, `fetch('/api/auto-apply/policies',{headers:{'x-workie-applicant':'household-dy-v1'}}).then(r=>r.json()).then(j=>j.runnerAvailable)` returns `true`.

### Task 6 (operator): Recruiter lookup and senders

- [ ] **Step 1:** Create a Hunter.io account and API key. Optionally do the same for Findymail.
- [ ] **Step 2:** `vercel env add WORKIE_HUNTER_API_KEY production` (paste at the prompt; never in argv). Optionally add `WORKIE_FINDYMAIL_API_KEY`. Redeploy.
- [ ] **Step 3:** Senders need nothing: `WORKIE_GMAIL_USER_2` is May's Gmail (confirmed 2026-10-07). Mail goes only from an address that matches the applicant's account or confirmed personal email (`lib/applications/outreach.ts:161`); otherwise the draft holds as `sender_not_configured`. 
- [ ] **Step 4 (verify):** the next submitted application's draft on `/applications` has **To** filled with source `hunter`. The two existing DY drafts stay `no_recipient`, because held drafts don't re-run the lookup. Type an address and press **Send**, or leave them.

### Task 7 (operator, May): Start applying

- [ ] **Step 1:** In any browser May or DY ticked board rows in, check `localStorage['workie-applied-synced']`. Entries are `ownerId:postingId`. The old code reported every check to whichever applicant was active, so any posting ID listed under both owners leaked to one of them. This Mac's built-in browser had none on 10/7.
- [ ] **Step 2:** Re-queue May's two Figma Greenhouse roles (`4195f0b0…`, `f9f5c90b…`). Follow the reapply steps saved from 10/6: allow reapplication for 1 day, POST `/reapply`, then set it back to off/365. The 02:00 PDT 10/7 wait has passed. The Ashby/Lever roles can't be applied to until their adapters exist.
- [ ] **Step 3:** With May's yes, **Create run** for worker `593c59f8`.
- [ ] **Step 4:** Each **Approve and submit** and each **Send email** needs May's own yes (`docs/may-claude-prompt.md`).
