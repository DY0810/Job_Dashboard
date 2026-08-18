# Workie

Local job dashboard. Next.js 15 (App Router) + TypeScript + Tailwind v4 + Drizzle ORM
over SQLite.

## Commands

```bash
npm run dev          # dev server at http://localhost:3000
npm run build        # production build
npm run db:migrate   # apply schema to workie.db (run `db:generate` first after schema changes)
npm test             # run the vitest suite
```

## Database

SQLite file at `./workie.db`, created by `npm run db:migrate`. Not committed — see
`.gitignore`. Schema lives in `lib/db/schema.ts`, migrations in `./drizzle`.

## Everything else

See [`plans/workie.md`](plans/workie.md) for architecture, phases, and gates.
