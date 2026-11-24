-- Step 16 backend, agent R3 (B27), changed at the combine (24 Nov 2026): the closed-job read (GET /api/job/closed) answers only for a job its employer closed
-- or that expired, never for a job staff removed, a draft, or one that closed under review (S20). app_candidate may not read job.close_reason
-- (permissions.test.ts), so it goes through one security definer function that returns only those two reasons and only the columns the page shows.
set role portal_owner;

create function private.candidate_closed_job(p_job bigint)
returns table (job_id text, title text, employer_name text, county text, reason text, closed_at timestamptz, sector text, occupation_code text)
language sql stable security definer set search_path = public, pg_temp as $$
  select j.id::text, j.title, j.employer_name, j.county, j.close_reason, j.closed_at, j.sector, j.occupation_code
  from job j where j.id = p_job and j.status = 'closed' and j.close_reason in ('closed', 'expired')
$$;
grant execute on function private.candidate_closed_job(bigint) to app_candidate;

-- B23: the company page shows the data cut-off, the newest month any DETE row covers (public-pages.ts CUT_OFF). Without this index it reads every row of
-- dete_permit_count (1,155 pages on 120,000 monthly rows); with it, one index entry. Monthly rows only, so the yearly totals are not in it.
create index dete_permit_count_month_idx on dete_permit_count(year desc, month desc) where month is not null;

reset role;
