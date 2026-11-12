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

## Try Google sign-in on localhost (by hand, never in `npm run check`)

Needs the candidate app on `http://localhost:3000`, a database with the migrations and one saved `signup_terms` text (the placeholder command in `docs/database.md`), and a Google OAuth client whose authorised redirect address is `http://localhost:3000/api/auth/candidate/callback/google`, with a real Google account added as a test user. Put the client ID and secret in your shell, not in a file in the repo.

1. Start the app with `DATABASE_URL` (the `app_candidate` login), `CANDIDATE_AUTH_URL=http://localhost:3000`, `CANDIDATE_AUTH_SECRET` (32 or more random characters), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, then `npm run dev:candidate`.
2. From the browser console on `http://localhost:3000` run `fetch("/api/auth/candidate/sign-in/social",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"google",callbackURL:"/",additionalData:{needsPermit:true,over18:true,acceptsTerms:true}})}).then(r=>r.json()).then(j=>location.href=j.url)`. Pick the test Google account. You come back to `/` with a `candidate.session_token` cookie.
3. Check in the database: one new `candidate_user` with `email_verified` true, one `candidate_account` with `provider_id` `google`, one `consent_record` with the three answers in `details`.
4. Sign in again with the same call but no `additionalData`: you get a session and no new `consent_record` row.
5. Refusal: sign out, use a second Google test account and call without `additionalData`: you land on `/api/auth/candidate/error?error=SIGNUP_ANSWERS_REFUSED` and no rows appear.
6. Start the app without `GOOGLE_CLIENT_SECRET`: the same call answers 404 "provider not found".
