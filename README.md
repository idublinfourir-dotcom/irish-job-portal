# Irish job portal

A candidate site, an employer portal and an admin, in one repo.

| Path | What it is | Local port |
|---|---|---|
| `apps/candidate` | Public job site and candidate accounts | 3000 |
| `apps/portal` | Employer and agency portal | 3001 |
| `apps/admin` | Staff admin | 3002 |
| `packages/db` | Postgres connection and Drizzle schema | |
| `packages/auth` | Better Auth, three separate login pools | |
| `packages/rules` | The job rules and the decision chain: one advert in, one assessment out | |
| `packages/matcher` | Job title and advert text to occupation code: the rules matcher, the AI matcher, and the 98% gate that scores them | |
| `packages/sources` | Job-board adapters (Greenhouse, Ashby, SmartRecruiters, Workday, Amazon) and the LinkedIn guest pages | |
| `packages/fetcher` | Reads the job boards, runs each advert through the rules and saves the result as the database role `app_fetcher` | |

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run dev:candidate   # or dev:portal, dev:admin
npm run check           # types, lint, tests and builds (needs the test database: npm run db:test:up)
npm run test:perf       # the page gate: a full-size fake fill, then no list page may read over 1,000 pages (about 2 minutes)
npm run test:mutation   # removes one database rule at a time to list the rules no test would miss (long, needs its own database server)
```

Read `docs/database.md` before touching the database and `docs/job-rules.md` before touching a job rule, the matcher, an adapter or the fetcher. Two things run by hand and never in `npm run check`, because they reach the outside world: one fetch of the real job boards (`packages/fetcher/vitest.run.config.ts`) and the 98% gate run (`packages/matcher/src/gate/README.md`). `docs/job-rules.md` has the commands.

Copy `.env.example` to `.env.local` in an app to connect a database. Pages work without one, and `/api/health` then reports the database as down.
