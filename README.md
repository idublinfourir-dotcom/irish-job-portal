# Irish job portal

A candidate site, an employer portal and an admin, in one repo.

| Path | What it is | Local port |
|---|---|---|
| `apps/candidate` | Public job site and candidate accounts | 3000 |
| `apps/portal` | Employer and agency portal | 3001 |
| `apps/admin` | Staff admin | 3002 |
| `packages/db` | Postgres connection and Drizzle schema | |
| `packages/auth` | Better Auth, three separate login pools | |

## Run it

Needs Node 24 or newer.

```bash
npm install
npm run dev:candidate   # or dev:portal, dev:admin
npm run check           # types, lint, tests and builds
```

Copy `.env.example` to `.env.local` in an app to connect a database. Pages work without one, and `/api/health` then reports the database as down.
