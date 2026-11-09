# Removed trial checks

On 9 November 2026 individual checks whose rule has changed were removed from `packages/db/test/clash.test.ts` and `retest.test.ts`. Every other check of those two trial scripts still runs. The last commit that contains the removed checks is `5af2d90`: `git show 5af2d90:packages/db/test/clash.test.ts` (and `retest.test.ts`).

The trial's plain notes (checks with no pass or fail) are kept as `// NOTE` comments in the two files (5 in each). Fixture steps that the migrations made outdated were rebuilt, not removed, and carry a `ported change` comment, so the checks after them run: the ban fixtures (a ban shares its strike case's approval request), the administrator request in the staff_role section, the appeal in the strike section, the lifted ban, and the notice insert (through `portal_notification`).

## clash.test.ts: 24 checks removed

Replaced because the two-person model of the migrations changed the rule: the acting id comes from `set local app.staff_user_id`, a ban shares its strike case's request and is applied in the same transaction, `app_admin` cannot write approval or appeal columns, and the trigger stamps the portal's reply and appeal times. The newer test that covers the rule is named for each.

| Removed check | Covered by |
|---|---|
| [strike] approval trigger: a level 3 strike cannot apply on a confirmed strike_2 request (wrong kind for level 3) | two-person: `[strike] strike 3 must not: outcome strike level 3 with a strike_2 request` |
| [strike] approval trigger: a level 3 strike cannot apply on one person's pending request | two-person: `[strike] strike 3 must not: one person (proposer) is also the confirmer`, and `[strike] strike 2 must not: a pending request` (same trigger branch) |
| [strike] approval trigger: a level 3 strike cannot apply on a refused request | two-person: `[strike] strike 2 must not: a refused request` (same trigger branch, level 2 only) |
| [strike] approval trigger: a level 3 strike cannot apply on a confirmed request for another case | two-person: `[strike] strike 2 must not: a confirmed request for another case` (same trigger branch, level 2 only) |
| [strike] approval trigger: a confirmed strike_3 request for this case works, and cannot be used twice | two-person: `[strike] strike 3 must do: confirmed, applied with the ban row, ...` and `[approval_request] applied once: a used request cannot be applied again to the same case by changing level and back` |
| [strike] a trigger refuses an employer reply after reply_due_at | two-person: `[strike] late reply must not: the portal replies after reply_due_at` |
| [strike] the 7-day appeal window: an appeal after appeal_due_at is refused, inside it works | two-person: `[strike] portal appeal must do: before appeal_due_at ...` and `[strike] portal appeal must not: after appeal_due_at` |
| [ban] approval trigger: a ban on one person's pending request is refused | two-person: `[strike] strike 3 must not: one person (proposer) is also the confirmer` (the request is checked once, on the strike row) |
| [ban] approval trigger: a ban on a refused request is refused | two-person: `[strike] strike 2 must not: a refused request` (same check on the strike row) |
| [ban] approval trigger: a ban on a confirmed request of another kind is refused | two-person: `[strike] strike 2 must not: a confirmed request of the wrong kind (ban)` and `[ban] ban must not: a ban row with a different request from the case's` |
| [ban] approval trigger: a ban on a confirmed request for another case is refused | two-person: `[ban] ban must not: a ban row with a different request from the case's` |
| [ban] approval trigger: a ban on a confirmed ban request for this case works | two-person: `[ban] instant ban must do: kind ban, outcome ban, ban row in the applying transaction` |
| [ban] approval trigger: a used ban request cannot make a second ban row for the same case | two-person: `[ban] ban probe: a second ban row on the same case in the applying transaction` |
| [approval_request] status confirmed needs confirmed_by_staff_user_id | two-person: `[approval_request] must do: a different person confirms, stamped with their id and the time` |
| [sponsorship_statement] admin_on_behalf requires confirmation_file_key and approval_request_id and no signer | smoke: `sponsorship_statement: refusal: admin_on_behalf by the portal (statement kind trigger)` covers the kind rule; the rest is in `coverage-gaps.test.ts` |

Outdated by a later fix:

| Removed check | Why | Covered by |
|---|---|---|
| [job] write guard: app_portal draft to live; a verified_restricted organisation cannot go live | The guard changes the status to `in_review` for a restricted organisation instead of refusing (0002, #44). The good half (a draft goes live for an organisation that is not restricted) stays as `[job] write guard: app_portal draft to live (organisation not restricted)`. | smoke: `job: restricted organisation: portal draft to live becomes in_review; scam/post_strike item queued; sponsor_confirmed refused`, and the `in_review` check in clash.test.ts |
| [alert] the send job reads alert_digest_max_jobs (it runs as app_candidate, the design says) | The setting is gone: the 20 is a constant in the send job's code (`0001_schema.sql`, line 813). | smoke: `setting: alert_digest_max_jobs row is gone` |

## retest.test.ts: 39 checks removed

All 39 were marked S-C3 in the old map. The retention rules changed on purpose, and `retention.test.ts` holds the later proven checks (the trial 3 checks; see `RESULTS-C3.md` in `prototype/load-tests/schema-trial-3/`). `run_retention` now does one batch per call and returns `{rule, done, left}` (it returned counts and `more`), the on-request erasure takes a second argument, and #99 and #133 keep `offer_details` on closed cases. The `retention.test.ts` names below are as of 9 Nov 2026.

| Removed check | Covered by (`retention.test.ts` unless stated) |
|---|---|
| [2 erasure] erase_candidate as app_admin: one call removes a candidate who has everything at Launch A | `[ks] candidate row, login rows and owned rows gone (47-extra)` and the other `[ks]` checks |
| [2 erasure] offer_details on the kept case still hold what the person typed about the offer | `[ks] closed case kept: offer_details kept, requester_erased_at set, document copy gone`, `[erase] i5 and d1 case records kept with offer_details ...`, `[cases] 314` (#99, #133) |
| [2 erasure] after closing that item by hand: membership removed and emptied, Better Auth rows and pending email gone | `[pks] portal user, logins and notifications gone; membership removed, person key empty`, `[pks] outbox: pending deleted ...` |
| [11 run_retention] expired_login_rows (9 checks: session, verification and rate_limit in the candidate, portal and staff pools) | `[logins] expired sessions, verification and rate-limit rows (2 days) deleted in all three pools; fresh ones kept` |
| [11 run_retention] apply_click: rows older than 14 days go, newer stay | `[small] apply_click: 15 days gone, 5 days kept` |
| [11 run_retention] email_outbox_sent: sent rows older than 30 days go | Rule changed (#133): the body is emptied at 30 days and the record goes at 24 months. `[outbox] sent 31 days: body (params) emptied, row kept ...`, `[outbox] record deleted at 24 months ...` |
| [11 run_retention] notification_read: read notices older than 90 days go | Rule changed: unread notices go too. `[messages] notification: read 13 months and unread 13 months deleted; 11 months both kept` |
| [11 run_retention] fetch_run: rows older than 90 days go | `[jobs] fetch_run: 13 months deleted, 11 months kept` |
| [11 run_retention] review_item_done: done items older than 12 months go | `[messages] review_item: done 25 months and dropped (created 25 months) deleted; 23 months and open kept` |
| [11 run_retention] contact_message: closed messages older than 12 months go | `[messages] contact_message: closed 25 months, answered-never-closed 25 months and spam 25 months deleted ...` |
| [11 run_retention] rejected_advert: rejected adverts older than 12 months go | `[jobs] rejected advert 25 months with no job deleted ...` |
| [11 run_retention] services_case_copy: copies 30 days after the case closed are emptied | `[cases] 311 (closed 31 days): document copy deleted, copy key returned` |
| [11 run_retention] portal_signer_name: statements 12 months after the job closed read "member of [organisation]"; statements a strike points to keep the name | `[small] signer names: statements 1 and 10 replaced, 2 (11 months) and 3 (strike points to job) kept; floor 1 replaced ...` |
| [11 run_retention] portal_signer_name: pay floors 12 months after ended_at | same `[small] signer names` check |
| [11 run_retention] strike_and_report_evidence: a cleared strike case 12 months after the decision goes | `[strikes] strike 1 (decided 13 months, no ban) deleted; its report 1 then goes; report 2 ...` |
| [11 run_retention] strike_and_report_evidence: a decided report 12 months on goes | same `[strikes]` check |
| [11 run_retention] closed_job_unreferenced: an old closed fetched job goes with its advert, text and daily stats | `[jobs] closed job 36+ months with nothing pointing to it deleted with its advert and statement ...`, `[jobs] job 1202 deleted: its daily stat and text gone ...` |
| [11 run_retention] closed_job_unreferenced: the fetched advert goes with it | same `[jobs]` checks |
| [11 run_retention] closed_job_unreferenced: an old closed employer job goes with its sponsorship statement (build 16) | same `[jobs]` checks |
| [11 run_retention] approval_request: an old unreferenced request goes (build 16) | `[approvals] approval_request older than 24 months: unreferenced 950 deleted ...` |
| [11 run_retention] deleted_account_grace: a candidate 31 days after asking is erased | `[accounts] d1 (deleted 31 days) erased, d3 (10 days) kept` |
| [11 run_retention] deleted_account_grace: a portal user 31 days after asking is erased | `[accounts] pd1 (deleted 31 days) erased; pd2 ...` |
| [11 run_retention] unverified_account: an unverified candidate after 7 days is erased | `[accounts] u1 (unverified 8 days) erased, u2 (5 days) kept` |
| [11 run_retention] unverified_account: an unverified portal login after 7 days is erased | `[accounts] pu1 (portal unverified 8 days) erased, pu2 kept` |
| [11 run_retention] inactive_profile_warning: 30 days after the warning with no login, the account is erased | Rule changed: the profile and CV are deleted and the login stays. `[inactive] i3 (warned 31 days ago): profile and CV deleted, login stays` |
| [11 run_retention] #99 freeze: the skipped record is listed for admin | `[apps] frozen application listed in skipped`, `[inactive] i6 ... listed as skipped`, `[accounts] d2 ... listed as skipped` |
| [11 run_retention] portal_removed_member: 30 days after the last membership ended, the portal user is erased | `[small] portal_removed_member: pr1 and pr3 erased; pr2 and pr4 kept` |
| [11 run_retention] storage keys returned for deletion | `[inactive] i3 CV storage key returned to the caller`, `[cases] 311 ... copy key returned`, `[erase] keys of erased people returned` |
| [11 run_retention] "in batches of 1,000 rows per transaction": a SECURITY DEFINER procedure cannot COMMIT between batches | smoke: `run_retention(): one batch per call: deleted_account_grace erases a due candidate, returns rule, done, left` (the caller repeats) |
| [11 run_retention] a call stops at 1,000 rows per rule and reports more = true | `more` became `left`: `[approvals] approval_request rule reports left = 0 once nothing more can go`, `[volume] 1,100 frozen candidates do not hide the 3 plain ones ...`, `[integrity] a second drain finds nothing to do` |
| [14 pseudonymise] after erasure, a scan of every column of every table finds the person's id or email only where stated | Only in part in `retention.test.ts`; the scan is in `coverage-gaps.test.ts` |

## Covered by coverage-gaps.test.ts

These removed checks had no newer test that stated the same rule. `packages/db/test/coverage-gaps.test.ts` now states each one, as the real role (`app_admin`), with the acting staff id set local. Each test holds the refusal (with the error text) and, where the rule allows something, the good case.

| Removed check | Covered by (`coverage-gaps.test.ts`) |
|---|---|
| [ban] unique cro_number where not null | `[ban] unique cro_number where not null` |
| [ban] unique email_domain where not null | `[ban] unique email_domain where not null` |
| [staff_role] unique (staff_user_id, role) | `[staff_role] unique (staff_user_id, role)` |
| [approval_request] target_id is required (build 17) | `[approval_request] target_id is required, so a new row's request has a natural key (build 17)` |
| [approval_request] CONCURRENT: two pending requests for the same new row | `[approval_request] CONCURRENT: two pending requests for the same new row (same natural key): one is refused` |
| [approval_request] CONCURRENT: two people decide one request | `[approval_request] CONCURRENT: two people decide one request, one wins` |
| [sponsorship_statement] admin_on_behalf requires confirmation_file_key and approval_request_id and no signer | `[sponsorship_statement] admin_on_behalf requires confirmation_file_key and approval_request_id and no signer` |
| [sponsorship_statement] admin_on_behalf: the used request cannot be used again for the same job | `[sponsorship_statement] admin_on_behalf: the used request cannot be used again for the same job` |
| [strike] approval trigger at level 3 for a refused request and for a confirmed request for another case | `[strike] approval trigger at level 3: a refused request and a confirmed request for another case are refused; the case's own confirmed request works` |
| [14 pseudonymise] a scan of every column of every table after an erasure | `[14 pseudonymise] after erasure, a scan of every column of every table finds the person's id or email nowhere` (the scan also finds a second, unerased person, so it is not blind). The old check allowed one sent `email_outbox` row; erasure now swaps the id for a stand-in, so the scan finds nothing. |

## Not covered yet

Nothing.
