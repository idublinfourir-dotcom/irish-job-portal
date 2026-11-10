# CLAUDE.md

@AGENTS.md

## Project

Job portal for Irish work permit jobs: a candidate site, an employer portal and an admin, deployed separately from this one repo. The database is built by migrations, and the job rules, the occupation matcher (rules and AI), the 98% gate, the job-board adapters and the fetcher that saves found jobs are in `packages/`. There are no pages yet. Run `npm run check` before calling any change finished.

Decisions and evidence live outside this repo, in `~/Brainstorm about Job Portal/`. Read them before changing the stack or a product rule:

- `02-decisions.md`: the numbered decisions (#1 onwards) cited in code and docs.
- `13-prd.html`: product requirements.
- `22-tech-stack-proposal.md`: the locked stack, free limits, backup plan and module design.
- `23-database-design.md`: the table design, approved on 9 November 2026. Migrations follow it; its proof is in `prototype/load-tests/schema-trial-3/`.
- `prototype/load-tests/real-vercel/RESULTS.md`: the measurements behind the rules below.

Use the words in `GLOSSARY.md`. Before touching the database, read `docs/database.md`, the short page of every table, role and rule. Before touching a job rule, the matcher, a source adapter or the fetcher, read `docs/job-rules.md`.

## Rules from real testing

- **Connections:** apps use Supabase's transaction pooler (port 6543), and migrations use the session pooler (port 5432). The direct connection is IPv6 only, which neither Vercel nor the engineer's machine can reach.
- **Portable database:** use Supabase as plain Postgres only, with Better Auth for logins, because the database moves to a paid host later.
- **Light queries:** read advert text only for the rows shown. Search and job lists page by keyset, newest first or by salary, with counts capped at 200. Scoring every match touched 35,777 pages to show 20 results, and the big stalls (up to 33 seconds) came soon after bursts of that query.
- **Thin pages:** business logic lives in `packages/`, so tests run without a browser.
- **No real network in tests:** no test calls the real network. `vitest.setup.ts` makes any connection to a host other than loopback throw. Use a fake service.
- **Pinned versions:** exact versions are the ones tested on real hosting. Change one deliberately and re-check.

## The six checks

Every change that adds or alters code ships with all six. `npm run check` runs 1, 3, 4 and 6 where they exist.

1. **Linters:** `npm run lint` (no warnings allowed) and `npm run typecheck`.
2. **Mock services:** every outside service is reached through a fake. `vitest.setup.ts` refuses any non-loopback connection.
3. **Unit tests:** logic with no database, network or browser, in `apps/` and `packages/*/src/*.test.ts`.
4. **Integration tests:** `packages/db/test/` and `packages/fetcher/test/`, against the real test database (`npm run db:test:up`).
5. **Performance tests:** `npm run test:perf` is the page gate (a full-size fake fill, then every list page must read at most 1,000 pages; CI job `perf`). `packages/db/test/perf/pages.ts` puts a page budget on any new query. Code that reads untrusted text has a time budget test beside it.
6. **Security tests:** role permission tests in `packages/db/test/`, security headers in `apps/headers.test.ts`, the network guard in `apps/network-guard.test.ts`.

## Working limits (#113)

AI writes the code and holds no production credentials, and uses fake data only. One named person approves every production release and database change.
