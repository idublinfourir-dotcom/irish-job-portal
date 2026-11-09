# Removed trial checks

On 9 November 2026 these checks were removed from `packages/db/test/clash.test.ts` and `retest.test.ts`. Newer proven tests cover the same rules, or a later fix changed the rule on purpose. The last commit that contains them is `5af2d90`: `git show 5af2d90:packages/db/test/clash.test.ts` (and `retest.test.ts`). The trial's plain notes (checks with no pass or fail) were kept as code comments.

## Replaced by `two-person.test.ts` (26)

- fixture block starting { const o = await F.org({ status: "unclaimed" }), d = `${id("dom")}.te
- [sponsorship_statement] admin_on_behalf requires confirmation_file_key and approval_request_id and no signer
- [sponsorship_statement] admin_on_behalf: the used request cannot be used again for the same job
- [staff_role] unique (staff_user_id, role)
- fixture block starting { const first = await F.staff(), second = await F.staff(), third = awa
- [strike] approval trigger: a level 3 strike cannot apply on one person's pending request
- [strike] approval trigger: a level 3 strike cannot apply on a confirmed strike_2 request (wrong kind for level 3)
- [strike] approval trigger: a level 3 strike cannot apply on a refused request
- [strike] approval trigger: a level 3 strike cannot apply on a confirmed request for another case
- [strike] approval trigger: a confirmed strike_3 request for this case works, and cannot be used twice
- [strike] a trigger refuses an employer reply after reply_due_at
- [strike] the 7-day appeal window: an appeal after appeal_due_at is refused, inside it works
- fixture block starting { const o = await F.org(), j = await live({ organisation_id: o }), r =
- [ban] unique cro_number where not null
- [ban] unique email_domain where not null
- [ban] approval trigger: a ban on one person's pending request is refused
- [ban] approval trigger: a ban on a refused request is refused
- [ban] approval trigger: a ban on a confirmed request of another kind is refused
- [ban] approval trigger: a ban on a confirmed request for another case is refused
- [ban] approval trigger: a ban on a confirmed ban request for this case works
- [ban] approval trigger: a used ban request cannot make a second ban row for the same case
- fixture block starting { const o = await F.org(), mk = async () => ins("postgres", "strike", 
- [approval_request] status confirmed needs confirmed_by_staff_user_id
- [approval_request] target_id is required, so a new row's request has a natural key (build 17)
- [approval_request] CONCURRENT: two pending requests for the same new row (same natural key): one is refused
- [approval_request] CONCURRENT: two people decide one request, one wins

## Replaced by `retention.test.ts` (39)

- [2 erasure] erase_candidate as app_admin: one call removes a candidate who has everything at Launch A
- [2 erasure] offer_details on the kept case still hold what the person typed about the offer
- [14 pseudonymise] after erasure, a scan of every column of every table finds the person's id or email only where stated
- [2 erasure] after closing that item by hand: membership removed and emptied, Better Auth rows and pending email gone
- [11 run_retention] expired_login_rows: expired candidate_session rows go, live ones stay
- [11 run_retention] expired_login_rows: expired candidate_verification rows go
- [11 run_retention] expired_login_rows: old candidate_rate_limit rows go
- [11 run_retention] expired_login_rows: expired portal_session rows go, live ones stay
- [11 run_retention] expired_login_rows: expired portal_verification rows go
- [11 run_retention] expired_login_rows: old portal_rate_limit rows go
- [11 run_retention] expired_login_rows: expired staff_session rows go, live ones stay
- [11 run_retention] expired_login_rows: expired staff_verification rows go
- [11 run_retention] expired_login_rows: old staff_rate_limit rows go
- [11 run_retention] apply_click: rows older than 14 days go, newer stay
- [11 run_retention] email_outbox_sent: sent rows older than 30 days go
- [11 run_retention] notification_read: read notices older than 90 days go
- [11 run_retention] fetch_run: rows older than 90 days go
- [11 run_retention] review_item_done: done items older than 12 months go
- [11 run_retention] contact_message: closed messages older than 12 months go
- [11 run_retention] rejected_advert: rejected adverts older than 12 months go
- [11 run_retention] services_case_copy: copies 30 days after the case closed are emptied
- [11 run_retention] portal_signer_name: statements 12 months after the job closed read "member of [organisation]"; statements a strike points to keep the name
- [11 run_retention] portal_signer_name: pay floors 12 months after ended_at
- [11 run_retention] strike_and_report_evidence: a cleared strike case 12 months after the decision goes
- [11 run_retention] strike_and_report_evidence: a decided report 12 months on goes
- [11 run_retention] closed_job_unreferenced: an old closed fetched job goes with its advert, text and daily stats
- [11 run_retention] closed_job_unreferenced: the fetched advert goes with it
- [11 run_retention] closed_job_unreferenced: an old closed employer job goes with its sponsorship statement (build 16)
- [11 run_retention] approval_request: an old unreferenced request goes (build 16)
- [11 run_retention] deleted_account_grace: a candidate 31 days after asking is erased
- [11 run_retention] deleted_account_grace: a portal user 31 days after asking is erased
- [11 run_retention] unverified_account: an unverified candidate after 7 days is erased
- [11 run_retention] unverified_account: an unverified portal login after 7 days is erased
- [11 run_retention] inactive_profile_warning: 30 days after the warning with no login, the account is erased
- [11 run_retention] #99 freeze: the skipped record is listed for admin
- [11 run_retention] portal_removed_member: 30 days after the last membership ended, the portal user is erased
- [11 run_retention] storage keys returned for deletion
- [11 run_retention] "in batches of 1,000 rows per transaction": a SECURITY DEFINER procedure cannot COMMIT between batches
- [11 run_retention] a call stops at 1,000 rows per rule and reports more = true

## Outdated by a later fix

- K-C, the migrations now move a restricted organisation's job to `in_review` instead of refusing it (#44); the matching `in_review` check still runs.
  - [job] write guard: app_portal draft to live; a verified_restricted organisation cannot go live
- K-E, the send job no longer reads `setting` as `app_candidate` (grant tightened), and the `notification` fixture block that crashed on that grant is dropped with it.
  - [alert] the send job reads alert_digest_max_jobs (it runs as app_candidate, the design says)
  - fixture block starting { const c = await F.cand(), k = id("dk"); const nt = (x) => ins("postg
- K-F, `app_portal` no longer inserts into `notification` directly (table grants changed).
  - [10 normal code] app_portal: one notice: ON CONFLICT (dedupe_key) DO NOTHING
