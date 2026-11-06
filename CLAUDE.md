# CLAUDE.md

@AGENTS.md

## Project

Job portal for Irish work permit jobs: a candidate site, an employer portal and an admin, deployed separately from this one repo. The workspace is set up, with no domain code yet. Run `npm run check` before calling any change finished.

Decisions and evidence live outside this repo, in `~/Brainstorm about Job Portal/`. Read them before changing the stack or a product rule:

- `02-decisions.md`: the numbered decisions (#1 onwards) cited in code and docs.
- `13-prd.html`: product requirements.
- `22-tech-stack-proposal.md`: the locked stack, free limits, backup plan and module design.
- `prototype/load-tests/real-vercel/RESULTS.md`: the measurements behind the rules below.

## Rules from real testing

- **Connections:** apps use Supabase's transaction pooler (port 6543), and migrations use the session pooler (port 5432). The direct connection is IPv6 only, which neither Vercel nor the engineer's machine can reach.
- **Portable database:** use Supabase as plain Postgres only, with Better Auth for logins, because the database moves to a paid host later.
- **Light queries:** read advert text only for the rows shown. Search and job lists page by keyset, newest first, with counts capped at 200. Scoring every match touched 35,777 pages to show 20 results, and the big stalls (up to 33 seconds) came soon after bursts of that query.
- **Thin pages:** business logic lives in `packages/`, so tests run without a browser.
- **Pinned versions:** exact versions are the ones tested on real hosting. Change one deliberately and re-check.

## Working limits (#113)

AI writes the code and holds no production credentials, and uses fake data only. One named person approves every production release and database change.
