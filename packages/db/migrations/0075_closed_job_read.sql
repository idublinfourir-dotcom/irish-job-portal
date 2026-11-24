-- Step 16 backend, agent R3 (B27): app_candidate may read job.close_reason, so the closed-job read (GET /api/job/closed) can answer only for a job its employer
-- closed or that expired (close_reason closed or expired) and never for a job staff removed, a draft, or one that closed under review (S20). The code only: an
-- enum of six words, no report, reporter or staff note.
set role portal_owner;

grant select (close_reason) on job to app_candidate;

-- B23: the company page shows the data cut-off, the newest month any DETE row covers (public-pages.ts CUT_OFF). Without this index it reads every row of
-- dete_permit_count (1,155 pages on 120,000 monthly rows); with it, one index entry. Monthly rows only, so the yearly totals are not in it.
create index dete_permit_count_month_idx on dete_permit_count(year desc, month desc) where month is not null;

reset role;
