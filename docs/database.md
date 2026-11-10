# Database

The map of the Postgres schema: roles, rules, tables, retention and callable functions. Read it before you write a migration, a query or a grant.

The files in `packages/db/migrations` are the source of truth once they exist. If this page and a migration disagree, the migration wins and this page is out of date: change it in the same pull request. The full design (60 tables, 11 views, the reasoning and the trial evidence) is a private document, see the last section. Words follow `GLOSSARY.md`. Numbers like #104 are entries in the decision log.

The Drizzle schema in `packages/db/src/schema` is made from the migrations, never written by hand: after changing a migration, run `npm run db:test:up` and then `npm run db:pull`. `schema.test.ts` fails until the two match.

`packages/db/test/rules-snapshot.txt` lists every trigger, CHECK rule, unique rule and app-role right in schema `public`, and `rules-snapshot.test.ts` fails when the database no longer matches it. After a migration that adds, drops or changes any of them, run `npx vitest run --project db packages/db/test/rules-snapshot.test.ts -u`, then read the diff of `rules-snapshot.txt` before committing it. A reviewer sees the same diff in the pull request.

## Roles

One role per deployed app, plus the owner. A bug on one site then cannot reach another side's tables.

| Role | Used by | Reaches |
|---|---|---|
| `portal_owner` | Migrations only | Owns every table, view and function. Never used at runtime |
| `app_candidate` | Candidate site | Candidate tables and its own login pool. Public job and organisation columns. Shared tables only through its views |
| `app_portal` | Employer and agency portal | Its own pool, organisation, membership, jobs, statements, pay floors. Shared tables only through its views. Nothing on candidate tables |
| `app_admin` | Admin panel | Staff tables, queues, cases, settings. Reads most things. Runs the erase and retention functions |
| `app_fetcher` | Job fetcher and importers | Fetched jobs and adverts, fetch runs, the CRO register. Inserts notifications. Nothing on candidate or staff tables |

There is no fifth role. Erasure and retention run inside database functions. Grants are by column wherever a role sees only part of a table.

Each app role has `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` set (migration 0000). These are defaults that stop honest code from holding the database up. They are not a limit: Postgres has no hard cap per role, so a hostile session can lift them with `set statement_timeout = 0` (`side-fixes.test.ts` documents this). Nothing in the database stops a hostile session from doing this, so the timeouts protect against slow honest code only.

## Rules for every table

- **Naming and types:** lowercase singular names, in schema `public`. Functions live in schema `private`. Ids are `bigint` identity, except Better Auth's text ids. Times are `timestamptz`, money is whole euros as integers, statuses are `text` with a CHECK. A CHECK on a column that may be empty is written so that NULL fails it (`is not distinct from` or an explicit `is not null`).
- **No row level security (#124).** A grant picks tables and columns, not rows. "Own rows only" (a candidate's saves, a company's jobs) is held by app code and its tests. The database holds the grants, the per-side views, the trust-column triggers and the clash rules.
- **Per-side views.** `services_case`, `case_document`, `consent_record`, `notification` and `notification_preference` hold candidate and portal rows together. `app_candidate` and `app_portal` get no rights on those five tables. Each gets views of its own side (`candidate_` and `portal_` plus the table name), made `security_barrier` with `check option`. `published_content_page` is the eleventh view.
- **Trust columns.** Columns that carry a claim or a decision (organisation status, big-company flag, `restricted_until`, job source and badge, hidden and in_review moves, pay floor status, block flags) are left out of the portal and fetcher grants. Where a grant cannot limit a value, a trigger checks `current_user`.
- **The acting staff id.** Every staff member connects as `app_admin`, so the admin app runs `set local app.staff_user_id` at the start of each transaction. Triggers on `approval_request` and `strike` refuse any `app_admin` write that has no valid acting id and stamp that id into the decider columns. Those columns are left out of every grant.
- **The two-person rule (#104, #136, #137).** A change on the #104 list takes effect only when it points to an `approval_request` confirmed by someone other than the proposer, and not used before. One trigger function checks this on every table that points to `approval_request`. Every staff role grant is two-person (#136). The confirmer must hold the role the request kind needs (#137).
- **Settings are two-person (migration 0004).** An `app_admin` insert or value change on `setting` needs an active acting id and a confirmed, unused `setting` request whose `change` is `{"value": <the new value>}` (`{"value": null}` for empty). The trigger stamps who and when and writes one `audit_event` row (`setting.change`) with the old and new value. A value is never negative. `app_admin` cannot change `key`, `unit` or the stamps. A migration as `portal_owner` is not blocked.
- **App roles write only their own side (migration 0004).** In `audit_event` each app role may name only its own actor (`app_candidate` a candidate, `app_portal` a portal user, `app_fetcher` a system actor, `app_admin` the acting staff id or a system actor), and `at` is always `now()`. Only `app_admin` and the fetcher write `admin_action`. In `email_outbox` an app role queues only new `pending` rows to its own side (`app_candidate` and `app_fetcher` candidates, `app_portal` portal users or invites, `app_admin` anyone). A `dedupe_key` sent by an app role is stored as `<role>:<key>` in `email_outbox` and `notification`, so `on conflict do nothing` works within a role and no role can take another's key. App code that looks a row up by key must add the prefix. Rows written by the owner's functions keep their key.
- **The public API stays shut.** Supabase's Data API is off. Every migration revokes rights from `anon`, `authenticated`, `service_role` and PUBLIC on tables and functions. Extensions go in schema `extensions`. `pg_graphql` is dropped.
- **Launch B is locked three ways (#72):** a `feature_flag` row; no grants on Launch B tables or functions until a named person runs that migration (#113); and two CHECKs on Launch A tables (`job.application_route = 'own_page'`, `candidate_profile.visible_to_employers = false`) that the same migration drops.
- **Delete actions.** Every foreign key states its delete action. Erasing a candidate cascades to their owned rows and sets null on shared records. A job with saved, tracker, application, case, report or strike rows cannot be deleted. `audit_event` and `email_outbox` hold person ids as plain text with no foreign key, so a log row never blocks a deletion.
- **Paging (#125):** next and previous only, keyed on the sort key plus `id`. Never `OFFSET`. Counts stop at 200. Every list query lives in the Search module and names its columns (never `select job.*`).
- **Periods are settings.** Nothing stores a delete date. `run_retention` works dates out from `setting`. The audit log period is the one exception.
- **Pooler.** Apps connect through Supabase's transaction-mode pooler: pass no statement name (`prepare: false`), use no `set` without `local`, no advisory locks, no `listen`.
- **Login pools (#97).** Candidate, portal and staff each have their own Better Auth tables, renamed with `modelName` and with camelCase fields mapped to lowercase. Added status columns are declared with `input: false`, and Better Auth does not enforce them, so the Identity module refuses suspended, blocked, disabled and deleted people on every request. Rate limits are stored in the database. Staff sign-up is off.

## Tables

Launch A unless marked. "Pool" tables are the five Better Auth tables of a login pool.

### Jobs

- `job`: one advert, whatever its source. `organisation_id` is who stands behind it (strikes fall there, including agency jobs, #89). Status moves draft, in_review, live, under_review, hidden, closed. `permit_type` is required, fetched jobs are always critical_skills (#42). The write guard trigger limits what each role may change, and `posted_at` is set by trigger, never by a role. The fetcher never moves a job back to draft, never changes the close reason of a closed job, and reopens a closed job, to live only, when it expired or the fetcher closed it, as `closed` or as `recheck_failed` (never one staff removed). The close reason `recheck_failed` (migration 0006) is for a live fetched job that fails a later check; a check allows it on fetched jobs only. List indexes are partial on `status = 'live'` and lead with `(not quota_full)`. `permit_history` is copied from the organisation by trigger.
- `job_text`: the advert text, kept until the job closes (#122). Also holds the text of a queued fetched advert. A trigger lets `app_fetcher` write text only for fetched jobs and `app_portal` only for employer and agency jobs.
- `job_source`: one row per job board, plus one for portal jobs. Its `last_ok_at` is the "last checked" date, so no job row changes nightly.
- `fetched_advert`: everything the fetcher has seen, rejected adverts included. All nightly churn lives here. Linked only from `job.fetched_advert_id`. `content_hash` is a sha256 hex of the advert as fetched (64 lowercase hex characters or empty, which means assess once more); only the fetcher writes it and only the fetcher and admin read it (migration 0006). A check keeps `stage` to 200 characters and `reason` and `quoted_evidence` to 500, so a rejected advert keeps short evidence and never the advert (#122).
- `fetch_run`: one row per fetch of one source.
- `job_daily_stat`: anonymous views and clicks per job per day (#56).

### Visitors and candidates

A visitor has no table. Their reports and contact messages are rows with no account attached.

- Candidate pool: `candidate_user`, `candidate_session`, `candidate_account`, `candidate_verification`, `candidate_rate_limit`. We add `suspended_at`, `deleted_at`, `last_active_at` and `inactive_warned_at` to the user table. An app role cannot set `last_active_at` more than five minutes ahead of the database clock. Only `erase_candidate` deletes a user.
- `candidate_profile`: details for matching, one row per candidate. Launch B lock: `visible_to_employers` must be false.
- `candidate_cv`: the current CV file record. The file is in private storage, the function returns its key for deletion.
- `saved_job`: a bookmark (#25). Unique per candidate and job.
- `tracker_entry`: the candidate's record of a job they applied to (#49, #86). Points to the job and copies no job details. On an on-site row a candidate can only set withdrawn, and the trigger checks the old route too, so changing the route in the same update does not get round it.
- `apply_click`: the "Did you apply?" prompt after a redirect (#49). One open prompt per candidate and job.
- `alert`: a saved search that sends email (#25, #77). The send updates `last_sent_at` only if still older than the period, so two runs cannot both send.
- `application` (Launch B): an application on our site (#45) with its own copy of what was sent. Erasure and retention empty it and keep job, date and outcome (#133).
- `contact_request` (Launch B): an employer asks a visible candidate for contact (#41, #47). Insert trigger enforces visibility, daily limit and re-ask gap.
- `message` (Launch B): text under an application or an accepted contact request (#98). No thread table, the parent is the thread.
- `candidate_hidden_organisation` (Launch B): companies a candidate hides from (#101, #129).

### Employers and agencies

- Portal pool: `portal_user`, `portal_session`, `portal_account`, `portal_verification`, `portal_rate_limit`. We add `status` (active, blocked), `blocked_at`, `blocked_reason_code`, `last_active_at`, `deleted_at`. Only `erase_portal_user` deletes a user.
- `organisation`: one company page and one team, which can exist before anyone claims it (#129). Triggers tie `status`, `restricted_until`, `claims_removed_at` and `is_big_company` to approved cases and requests (#44, #104). The portal creates and claims only through `claim_organisation` and `register_organisation`. Nothing is deleted, `closed` keeps the row.
- `organisation_name`: legal names and job-site names under an organisation (#30). Nothing merges automatically, admin confirms each link.
- `organisation_domain`: a company's email domains, for the sign-up domain rule (#37) and the ban rule. `created_at` is not writable by any app role (#137).
- `cro_company`: the CRO register, Normal companies only, for the first-time sponsor check (#21). Refreshed daily by the importer.
- `dete_permit_count`: permits per employer name from DETE files, for company pages and the permit history label (#73).
- `wrc_licence`: the WRC agency register, refreshed monthly (#22).
- `membership`: links a portal login to an organisation (#52, #103). One owner per organisation and one active company per login (#130). A viewer never signs.
- `sponsorship_statement`: the signed "we will sponsor" statement per job, which strikes hold employers to (#19, #44). One current statement per job. The signer must be an eligible active member. `admin_on_behalf` needs a confirmed approval request (#16, #104).
- `pay_floor`: a pay floor signed by a big-company employer for a role family, never an agency (#82, #100). Becomes active only with a confirmed approval request.

Agency permit employer facts have no table: they sit on the job columns and on `sponsorship_statement` (#23, #36, #89). A client is not an account type.

### Services, staff and admin

- Staff pool: `staff_user`, `staff_session`, `staff_account`, `staff_verification`, `staff_rate_limit`. Only `app_admin` has rights. Nobody signs up, an administrator creates each login. Users are disabled, never deleted. Turning on a disabled login that holds a role needs a confirmed grant (#136). `app_admin` cannot change the email of a login that holds a role: remove its roles first, then grant them again through confirmed requests. The database cannot tell Better Auth's own password and session writes from another staff member's, so the admin build must hold this rule itself: a staff login is created with no usable password and its owner sets one from an emailed link, and no staff member ever sets another's password.
- `staff_role`: which of the seven #104 roles a person holds. Every grant needs a confirmed request unless `seeded_by_owner`. Removing a role is one person's act (#137), and no trigger may guard that delete.
- `services_case`: one permit services request. Open means `status <> 'closed'`, and an open case freezes erasure of the people it names (#99). Candidate and portal sides use their views. A trigger makes the consent records a case names belong to the same person as the case.
- `case_note`: a handler's private note. `app_admin` only.
- `case_document`: a list of uploaded copies, never originals (#50). Files live in private EU storage. A trigger makes a candidate or portal document sit on a case of the same person.
- `case_quote`: a quote and invoice record paid by bank transfer (#84).
- `content_page`: guides, the updates feed and help pages (#55). Terms and privacy pages are consent texts, not content pages. Public read is through `published_content_page`.
- `contact_message`: the contact form and its staff inbox. Keeps the sender's name and email so staff can reply.
- `report`: a complaint about a job, company, message or profile (#38, #102). The reported company never reads this table. The reporter's identity is cleared when the report closes (#99).
- `strike`: one case against an organisation (false claim, false pay floor or instant ban, #44, #82, #96). Holds the notice, reply, decision and appeal. Triggers stamp the decider and the dates, set deadlines once, and stop one person entering and deciding the same reply or appeal (#134, #135, #136).
- `ban`: the ban list. A row existing means the ban stands. Never updated. Inserted only in the transaction that applies its case, and only for the case organisation's own CRO number or earlier domains (#137). Deleting needs a confirmed `ban_lift`.
- `approval_request`: the two-person rule (#104). A proposed change waits here. The proposer cannot confirm. Kinds and the confirmer role each needs are in the trigger. Rows are born pending. Kinds include `setting` (confirmed by an administrator).
- `review_item`: admin work queues with no table of their own, the fetched-job queue included. One winner claims an item. The portal never writes it, triggers and functions do. `app_fetcher` may insert only `scam_flag` items, with only `queue`, `job_id`, `reason` and `detail`.
- `audit_event`: the append-only log of staff actions, data views and security events. No app role can update or delete. Stores allow-listed values only, never names, emails or free text. Retention is below.

### Shared

- `consent_text`: the exact wording of each consent (#90). Never updated or deleted once published. Sign-up terms and privacy notice need a confirmed `terms_privacy_page` request.
- `consent_record`: proof of what one person agreed to and when. App roles cannot choose `given_at` (the default `now()` is the proof) and may update only `withdrawn_at`, once, from empty to `now()`. Erasure turns it into bare proof.
- `notification_preference`: choices per category and channel (#54). Rows exist only where someone differs from the default.
- `notification`: in-app notices, one row per member. Staff have none. A notice to the other side is written by a trigger or function, never by an app role.
- `email_outbox`: emails waiting to send, saved in the same transaction as the action. The address is looked up at send time. Workers claim with `FOR UPDATE SKIP LOCKED`.
- `feature_flag`: switches that keep Launch B off (#72). Only `portal_owner` writes, through a reviewed migration.
- `setting`: every period and limit that is not final. `app_admin` reads and writes `value`, `is_guess` and the solicitor columns. A value change is two-person, and every change is logged by the trigger. Empty means not set, so nothing is deleted automatically.

## Retention

Each key is a row in `setting`, run by `run_retention`. A rule skips any record an open case refers to (#99). #133 periods await solicitor confirmation.

| Key | Period | Decision |
|---|---|---|
| `application_and_cv` | 12 months after the job closes: candidate id, details and CV copy emptied | #60, #133 |
| `application_record` | 36 months after the job closes: the emptied application is deleted | #133 |
| `inactive_profile` | 12 months with no login, then a warning | #99, guess |
| `inactive_profile_warning` | 30 days after the warning: profile and CV deleted | #99, #133 |
| `inactive_account` | 24 months with no login: the rest of the account erased | #133 |
| `unverified_account` | 7 days, candidate and portal logins | guess |
| `deleted_account_grace` | 30 days, candidate and portal logins | guess |
| `apply_click` | 14 days | guess |
| `contact_request_record` | 12 months | guess |
| `contact_request_expiry` | 14 days | guess |
| `contact_request_reask` | 90 days | guess |
| `contact_requests_per_day` | 20 per organisation | guess |
| `claim_needs_info` | 30 days, then the claim returns to unclaimed | guess |
| `portal_removed_member` | 12 months after the last membership ends, or after sign-up if never a member | #133 |
| `draft_job` | 12 months after creation, if never posted | #99, #122, guess |
| `portal_signer_name` | 12 months after the job closes or the floor ends: signer name replaced | proposed |
| `services_case_copy` | 30 days after the case closes: uploaded copies deleted | #99, guess |
| `services_case_record` | 6 years after the case closes, offer details included | #133 |
| `case_invoice_record` | 6 years after the case closes | #133 |
| `strike_and_report_evidence` | 12 months after decision and appeal, unless a ban rests on the case | #44, #99, #136 |
| `ban_evidence` | 12 months after the ban is lifted, for every case it rests on | #133, #136 |
| `consent_bare_proof` | 6 years after the person is erased | #133 |
| `contact_message` | 24 months after it closes (or after it was sent if answered or spam and never closed) | #133 |
| `review_item_done` | 24 months | #133 |
| `notification_read` | 12 months after it was read | #133 |
| `notification_unread` | 12 months after creation, if never read | #133 |
| `email_outbox_sent` | 30 days after sending: body (`params`) emptied | #133 |
| `email_outbox_record` | 24 months: send record deleted | #133 |
| `rejected_advert` | 24 months | #133 |
| `closed_job_unreferenced` | 36 months: closed job deleted with its advert, statements and stats | #133 |
| `fetch_run` | 12 months | #133 |
| `expired_login_rows` | 1 day after expiry (rate-limit rows: after last request) | guess |
| `staff_entry_grace` | 7 days after a due date, for staff to enter a reply or appeal that arrived by email or post | #136 |
| Audit log | 24 months, written in `audit_purge`, changed only by a reviewed migration | review 12 |

`approval_request` rows go after the audit period, only when no row points to them.

## Callable functions

All are `SECURITY DEFINER`, owned by `portal_owner`, in schema `private`, with execute revoked from PUBLIC. Each writes its own `audit_event` rows in the same transaction. Trigger functions also live in `private` and are granted to no role.

- `erase_candidate(id, on_request)`: erases a candidate. Refuses (and returns the reason) while they have an open services case or are the target of an open report. Empties applications, turns consents into bare proof, deletes owned rows and login rows, calls `audit_pseudonymise`. Returns the storage keys of files to delete. Executed by `app_admin`.
- `erase_portal_user(id, on_request)`: the same for a portal login. Also refuses an account owner who still has other active members. Executed by `app_admin`.
- `run_retention()`: runs one batch (up to 1,000 rows) of the first retention rule with rows due, and returns that rule's key and how many rows are left. The admin app's scheduled route calls it in a loop, one transaction per call. Rules are listed in `private.retention_rules()`. Executed by `app_admin`.
- `audit_pseudonymise(id)`: replaces a person's id in the log with a random stand-in. Called only by the two erase functions. No app role.
- `audit_purge()`: deletes audit rows older than 24 months. Run by a monthly pg_cron job as `portal_owner`, or by the named person. No app role.
- `approval_request_due()`: returns the approval request ids that retention may delete. Used by `run_retention`.
- `claim_organisation(portal_user_id, organisation_id)`: a verified person claims an existing organisation, in one conditional update. Executed by `app_portal`.
- `register_organisation(portal_user_id, kind, display_name, cro_number, wrc_licence_number)`: sign-up for a first-time sponsor or an agency. Always pending review. Executed by `app_portal`.
- `move_application(application_id, status, membership_id)` (Launch B): moves an application and its tracker row together. `app_portal`, from the Launch B migration only.
- `search_visible_candidates(organisation_id, filters, cursor)` (Launch B): the portal's candidate search. `app_portal`, from the Launch B migration only.

## Deeper

The full design is `23-database-design.md` in the private brainstorm folder, held outside this repo. It has the access line of every table, every clash rule, the page-limit queries and the CI page check. The schema trial reports (`schema-trial`, `schema-trial-2`, `schema-trial-3` under `prototype/load-tests`) are in the same private folder. Ask the engineer for access.

Removed trial checks and where to find them: [removed-tests.md](removed-tests.md).
