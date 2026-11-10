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
| `packages/matcher` | Job title to occupation code | |
| `packages/sources` | Job-board adapters (Greenhouse, Ashby, SmartRecruiters, Workday, Amazon) | |

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run dev:candidate   # or dev:portal, dev:admin
npm run check           # types, lint, tests and builds (needs the test database: npm run db:test:up)
npm run test:perf       # the page gate: a full-size fake fill, then no list page may read over 1,000 pages (about 2 minutes)
npm run test:mutation   # removes one database rule at a time to list the rules no test would miss (long, needs its own database server)
```

Read `docs/database.md` before touching the database and `docs/job-rules.md` before touching a job rule, the matcher or an adapter.

Copy `.env.example` to `.env.local` in an app to connect a database. Pages work without one, and `/api/health` then reports the database as down.
