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

## Deploy (Vercel)

Each app is its own Vercel project; today only `apps/admin` is deployed: project `job-portal-admin`, `https://job-portal-admin-idublinfourir-1308.vercel.app`, behind Vercel's login wall (automated checks send the project's protection bypass secret in `x-vercel-protection-bypass`).

- Project settings: Root Directory `apps/admin` (or the app's folder), "Include files outside the root directory" on, Node.js 24.x. Each app's `vercel.json` sets the region (`dub1`) and installs from the repo root with `npm ci`, because an install inside the app folder skips the root's packages.
- Environment values (Production, Secret type, never printed): `STAFF_AUTH_URL` (the project's own https address, exactly), `STAFF_AUTH_SECRET` (32 or more characters), `DATABASE_URL` (the app's own database login, for admin `app_admin` through the Supabase pooler), `DATABASE_CA_CERT`. A change reaches the app only with a new deploy.
- The candidate and portal apps also take `FILES_S3_KEY_ID`, `FILES_S3_SECRET` (Secret type), `FILES_S3_BUCKET` (`irish-job-portal-files`) and `FILES_S3_REGION` (`eu-west-1`) for stored files. Without any one of them only the file routes answer 503. The daily retention step gets the same four (`.github/workflows/daily-fetch.yml`, secrets `FILES_S3_KEY_ID` and `FILES_S3_SECRET`). Check a new key by hand with `node packages/db/src/file-store-check-cli.ts` (it reaches the real S3).
- The candidate and portal apps also take `BOT_CHECK` (Vercel BotID, Basic mode, free). Leave it unset: it is off unless the value is exactly `on`. Turn it on in each app's Vercel settings (Production) only after the pages that call the checked routes are live (step 16), then check one real sign-up from a page in a browser. With it on, a request that did not come from a page with `instrumentation-client.ts` loaded (a script, `curl`) is refused with 403 `BOT_SUSPECTED`. A change reaches the app only with a new deploy.
- Error tracking (Sentry, decision #267; org `dublin4ir`, EU region, one project per app: `irish-job-portal-candidate`, `-portal`, `-admin`). Without the two DSNs Sentry is off. Each app takes:
  - `SENTRY_DSN`: the app's project DSN, for the server.
  - `NEXT_PUBLIC_SENTRY_DSN`: the same DSN, for the browser. It is built into the page, so it needs a new build to change; it is public by design.
  - `SENTRY_AUTH_TOKEN` (Secret type, build only): uploads source maps at build time. Without it the build passes and uploads nothing. Never read from client code.

  Sentry receives errors and traces (10% of requests in production, all in preview), with the release (`APP_VERSION`) and environment (`VERCEL_ENV`). It never receives cookies, headers, request or response bodies, IP addresses, user ids or emails, database query values, stack-frame variables, URL query strings or fragments (stripped from every URL, since presigned file links and reset links carry secrets there), or any email address in a message (replaced with `[email]`). No Session Replay, no Sentry logs. All of it is set in one place, `packages/auth/src/sentry.ts`. Never call `Sentry.setUser`.
- On the Hobby plan only the account owner can trigger a deploy. Pushes and merges by anyone else show as BLOCKED with a Vercel bot comment; that is expected, not a code failure. The owner starts the deploy (dashboard, CLI or API) after a merge.
- `apps/candidate` is not deployed: its email goes to the fake sender, which refuses to run anywhere but localhost until a real email service is wired in.

## Try Google sign-in on localhost (by hand, never in `npm run check`)

Needs the candidate app on `http://localhost:3000`, a database with the migrations and one saved `signup_terms` text (the placeholder command in `docs/database.md`), and a Google OAuth client whose authorised redirect address is `http://localhost:3000/api/auth/candidate/callback/google`, with a real Google account added as a test user. Put the client ID and secret in your shell, not in a file in the repo.

1. Start the app with `DATABASE_URL` (the `app_candidate` login), `CANDIDATE_AUTH_URL=http://localhost:3000`, `CANDIDATE_AUTH_SECRET` (32 or more random characters), `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` set, then `npm run dev:candidate`.
2. From the browser console on `http://localhost:3000` run `fetch("/api/auth/candidate/sign-in/social",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"google",callbackURL:"/",additionalData:{needsPermit:true,over18:true,acceptsTerms:true}})}).then(r=>r.json()).then(j=>location.href=j.url)`. Pick the test Google account. You come back to `/` with a `candidate.session_token` cookie.
3. Check in the database: one new `candidate_user` with `email_verified` true, one `candidate_account` with `provider_id` `google`, one `consent_record` with the three answers in `details`.
4. Sign in again with the same call but no `additionalData`: you get a session and no new `consent_record` row.
5. Refusal: sign out, use a second Google test account and call without `additionalData`: you land on `/api/auth/candidate/error?error=SIGNUP_ANSWERS_REFUSED` and no rows appear.
6. Start the app without `GOOGLE_CLIENT_SECRET`: the same call answers 404 "provider not found".

## Live check of the public pages (G5, by hand before launch, never in `npm run check`)

`node packages/db/src/live-check-cli.ts [report.md]` reads the rendered public pages of `www`, `employers` and `admin.irishworkpermit.ie` the way a visitor gets them and exits 1 when a page is not 200 (the style kit, a made-up path and absent `robots.txt`/`sitemap.xml` must be 404), a link, image, form or meta address holds localhost, 127.0.0.1, example.com, vercel.app, `.invalid`, staging or plain `http://`, a canonical is off the page's own site, or the visible text has placeholder words ("PLACEHOLDER", "Not published yet", "coming soon", "lorem", "No updates here yet") or raw Markdown. It prints the Markdown report (or only its total line when a file is given). It is expected to fail until the legal texts are published.

- It sends each site's Vercel bypass secret from `~/.config/portal/vercel-bypass-candidate`, `vercel-bypass-portal` and `vercel-bypass` as `x-vercel-protection-bypass`, and never prints it.
- GET only, one request per 1.1 s, at most 120 requests; it follows redirects on the same origin only and reports the rest. It never opens a job page (`/jobs/<job>`, each render writes a view row); it counts those links. Every read still writes a rate-limit row (`packages/db/src/public-read.ts`).
- A page reached through a redirect is judged under the address that redirected. Job markup (JSON-LD) is "not checked" here; it is tested in `packages/db/test/job-pages.test.ts`.
- `LIVE_CHECK_SITES` (a JSON list of `{origin, secretFile, paths, notFound}`) points it at other sites, such as a preview deployment; only loopback sites (the tests) may set a faster `LIVE_CHECK_PACE_MS`.
