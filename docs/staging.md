# Staging

Staging is a second Workie at **https://workie-staging.ieverse.ai** with its own databases,
document store and household secrets. Use it to try a change end to end (dashboard and a
worker filling and submitting a form) before it reaches production.

## What is separate from production

| Piece | Production | Staging |
| --- | --- | --- |
| Deploys from | `main` | the `staging` branch (Vercel custom environment `staging`) |
| Catalog DB (`TURSO_*`) | `workie` | `workie-staging` (group `default`, no new location) |
| Private DB (`WORKIE_PRIVATE_*`) | `workie-applicants-2` | `workie-staging-applicants` |
| Resumes (Blob) | `workie-private-documents` | `workie-staging-documents` |
| Applicants | DY, May | fake `dy-staging@example.com`, `may-staging@example.com` |
| Household secret, passcode, draft key, cron secret | prod values | staging-only values |

Staging has **no** Hunter key, Gmail, send token or GitHub token, so it sends no email, looks up no
recruiters and never starts the production ingest workflow. The 30-minute cron only runs in
production. PR preview deployments read the staging catalog DB too, never the production one.

The staging passcode lives only in Vercel. Read it with
`vercel env pull --environment=staging <file>` and delete the file afterwards.

## Submits only reach the fixture role

Outside production (`VERCEL_ENV !== 'production'` on Vercel), the server refuses a submission
intent unless the role is on the Greenhouse tenant `workie-staging-fixture`
(`lib/applications/submissions.ts`). The worker refuses to click submit without that intent. A
worker answers every `job-boards.greenhouse.io/workie-staging-fixture/...` page from the e2e
fixture form in `worker/ats/greenhouse-fixture.ts`, so nothing reaches Greenhouse. The form asks
for an emailed code at submit; enter `ABCD1234` on Workie.

`scripts/staging-seed.ts` puts that one role (Fixture Co, Software Engineering Intern) into the
staging catalog and refuses any other database. Re-run it when the role is older than 60 days:

```sh
TURSO_DATABASE_URL=<staging url> TURSO_AUTH_TOKEN=<staging token> node scripts/staging-seed.ts
```

The Jobs board hides Greenhouse, Lever and Ashby roles (they belong to Auto Apply), so the
fixture role shows only in Auto Apply.

## Try a change on staging

1. Push the PR branch to staging: `git push --force origin <branch>:staging`. Vercel builds it
   at the staging URL in about two minutes.
2. Sign in at https://workie-staging.ieverse.ai/sign-in as DY with the staging passcode.
3. Fill the Profile, upload a resume, and save an Auto Apply policy that allows
   `job-boards.greenhouse.io`, country `US`, actions read/fill/submit.
4. Run a staging worker (below), start a run, approve the filled form, and enter `ABCD1234`
   when asked for the code.
5. Merge the PR to `main` once staging looks right.

## Staging worker

Run it from a checkout of the `staging` branch, in its own terminal, with its own data
directory. Its keychain entries are scoped to the staging origin, so it never touches the
production workers (`com.workie.worker-dy`, `com.workie.worker-may`).

```sh
export WORKIE_WORKER_ORIGIN=https://workie-staging.ieverse.ai
export WORKIE_WORKER_OWNER=<owner id shown on staging Auto Apply>
export WORKIE_WORKER_DIRECTORY="$HOME/.local/share/workie-worker-staging"
umask 077 && mkdir -p "$WORKIE_WORKER_DIRECTORY"
npm run worker -- pair    # paste the grant from staging Auto Apply at the hidden prompt
npm run worker -- start
```

Tailoring still needs the provider set up as in `docs/worker.md`.
