-- Step 15 gap wave 1 (18 Nov 2026): four marks on a job that were missing or late.
--   1. P14: job.exception_confirmed_at. The employer's exception tick (an Ineligible entry "with the exception of ...", or a condition in
--      apps/portal/lib/jobs.ts CONDITIONS) is stored when a post or an edit passes the rules with it, and cleared when the rules pass without it
--      (the code changed to one with no condition), so a renewal reads it instead of asking again. Jobs now live, in review or under review whose
--      code has a condition could only have passed with the tick, so they get it now.
--   2. job.under_review_reason: why a job is under review, stored with the move. 'pay_check' (the daily rules run, the minimums rose) or the rule
--      code a renewal failed on (apps/portal/lib/jobs.ts jobRenew). Kept while the job stays under review, cleared when it leaves (the 0027
--      trigger, which now sets both). private.portal_jobs shows it.
--   3. S8: job.quota_full is right on every write: a trigger reads generalQuotaFullCodes from the minimums version in force whenever a job is
--      written with its permit type or code. The daily rules run still recomputes every open job when a new version applies (rules-run-cli.ts).
--   4. P8: the 20-copy limit on a job's written authority holds under two uploads at once: the insert locks the job row and counts again.
--   5. private.job_guard copied whole from 0044 with one more portal move: under_review to live for a job a renewal moved for a non-pay rule
--      (under_review_reason other than 'pay_check') when the same update changes a field the rules read (the advert text through search_vector).
--      The edit route runs the rules first (apps/portal/lib/jobs.ts jobEdit). A 'pay_check' job still needs a pay change (#93), unchanged.
set role portal_owner;

-- ===== 1. the exception tick
alter table job add column exception_confirmed_at timestamptz;
grant select (exception_confirmed_at), insert (exception_confirmed_at), update (exception_confirmed_at) on job to app_portal;
-- 6145 is CONDITIONS in apps/portal/lib/jobs.ts; the rest are the Ineligible entries in force that name an exception.
update job j set exception_confirmed_at = now()
 where j.source in ('employer','agency') and j.status in ('live','in_review','under_review')
   and (j.occupation_code = '6145' or exists (
     select 1 from (select data from rules_version where kind = 'ineligible_list' and effective_from <= current_date order by effective_from desc, id desc limit 1) v,
       jsonb_array_elements(v.data) e where e->>'code' = j.occupation_code and strpos(e->>'title', 'with the exception of') > 0));

-- ===== 2. the under review reason
alter table job add column under_review_reason text check (under_review_reason in ('pay_check', 'GENERAL_RULES_NOT_SET', 'OCCUPATION_INELIGIBLE', 'QUOTA_FULL',
  'OCCUPATION_NOT_ON_LIST', 'CONTRACT_TOO_SHORT', 'RULES_FAILED', 'PAY_REQUIRED', 'PAY_BELOW_MINIMUM', 'STATEMENT_REQUIRED', 'NEEDS_REVIEW'));
update job set under_review_reason = 'pay_check' where status = 'under_review'; -- the only move into under review until 0044
alter table job add constraint job_under_review_reason_check2 check ((status = 'under_review') = (under_review_reason is not null));
grant select (under_review_reason), update (under_review_reason) on job to app_portal;

-- A move in with no reason is a pay check (the meaning every under review job had before); the reason a move names is kept until the job leaves.
create or replace function private.job_under_review_since() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.under_review_since := case when new.status <> 'under_review' then null
    when tg_op = 'UPDATE' and old.status = 'under_review' then old.under_review_since else now() end;
  new.under_review_reason := case when new.status <> 'under_review' then null
    when tg_op = 'UPDATE' and old.status = 'under_review' then old.under_review_reason else coalesce(new.under_review_reason, 'pay_check') end;
  return new;
end $$;
drop trigger job_under_review_since on job;
create trigger job_under_review_since before insert or update of status, under_review_reason on job for each row execute function private.job_under_review_since();

-- 0019's function with the stored reason: under_review gives 'pay_check' or 'renewal_check' with reviewCode (the rule code), and exceptionConfirmed.
create or replace function private.portal_jobs(p_user text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user);
begin
  return coalesce((select jsonb_agg(x.j order by x.posted_at desc, x.id desc) from (
    select j.id, j.posted_at, jsonb_build_object(
      'id', j.id, 'title', j.title, 'status', j.status, 'badge', j.badge, 'passRoute', j.pass_route, 'occupationCode', j.occupation_code,
      'county', j.county, 'salaryLow', j.salary_low, 'salaryHigh', j.salary_high, 'payGrade', j.pay_grade, 'weeklyHours', j.weekly_hours,
      'postedAt', j.posted_at, 'closesAt', j.closes_at, 'closedAt', j.closed_at, 'closeReason', j.close_reason, 'hireAnswer', j.hire_answer,
      'reason', case j.status
        when 'in_review' then case when exists (select 1 from review_item r where r.job_id = j.id and r.queue = 'post_strike_job_review' and r.status in ('open','claimed'))
                                   then 'restricted_company' else 'staff_check' end
        when 'under_review' then case when j.under_review_reason = 'pay_check' then 'pay_check' else 'renewal_check' end
        when 'hidden' then j.hidden_reason end,
      'reviewCode', case when j.status = 'under_review' and j.under_review_reason <> 'pay_check' then j.under_review_reason end,
      'exceptionConfirmed', j.exception_confirmed_at is not null,
      'clientCheck', exists (select 1 from review_item r where r.job_id = j.id and r.queue = 'agency_client_check' and r.status in ('open','claimed'))) as j
    from job j where j.organisation_id = m.organisation_id and j.source in ('employer','agency')
    order by j.posted_at desc, j.id desc limit 200) x), '[]'::jsonb);
end $$;

-- ===== 3. the quota mark on every write
-- A General job: is its code in generalQuotaFullCodes of the minimums in force today (the version rules-run-cli.ts PICK applies)? A job that stops
-- being General loses the mark. Other jobs keep what they were written with: only app_admin may write the column (0003), the rules run clears it.
create function private.job_quota_full() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.permit_type = 'general' then
    new.quota_full := coalesce((select v.data->'generalQuotaFullCodes' from rules_version v where v.kind = 'minimums' and v.effective_from <= current_date
      order by v.effective_from desc, v.id desc limit 1) ? new.occupation_code, false);
  elsif tg_op = 'UPDATE' and old.permit_type = 'general' then
    new.quota_full := false;
  end if;
  return new;
end $$;
create trigger job_quota_full before insert or update of permit_type, occupation_code on job for each row execute function private.job_quota_full();

-- ===== 4. the written authority limit under a race
-- Security definer so the lock does not depend on the portal's column grants on job. The message is mapped to 409 DOCUMENT_LIMIT (packages/db/src/files.ts).
create function private.job_authority_limit() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform 1 from job where id = new.job_id for update;
  if (select count(*) from job_authority_document where job_id = new.job_id and storage_key is not null) >= 20 then
    raise exception 'authority refused: DOCUMENT_LIMIT' using errcode = 'P0001'; end if;
  return new;
end $$;
revoke all on function private.job_authority_limit() from public;
create trigger job_authority_limit before insert on job_authority_document for each row execute function private.job_authority_limit();

-- ===== 5. back to live after a renewal's non-pay rule is fixed
create or replace function private.job_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare from_status text; restricted boolean; held boolean;
begin
  if tg_op = 'UPDATE' and new.source <> old.source then raise exception 'job guard: source never changes' using errcode = 'P0001'; end if;
  select coalesce(o.restricted_until > now(), false) into restricted from organisation o where o.id = new.organisation_id;
  -- every role: sponsor_confirmed is refused while the organisation is restricted. PICK: refused when the badge is set or changed to it, so strike 2's own clean-up of an existing badge is not blocked.
  if new.badge = 'sponsor_confirmed' and restricted and (tg_op = 'INSERT' or old.badge is distinct from new.badge) then
    raise exception 'job guard: sponsor_confirmed is refused while the organisation is restricted' using errcode = 'P0001'; end if;
  from_status := case when tg_op = 'INSERT' then 'draft' else old.status end; -- an insert is treated as a move from draft
  if current_user = 'app_portal' then
    if new.source not in ('employer','agency') then raise exception 'job guard: the portal writes only employer and agency jobs' using errcode = 'P0001'; end if;
    if tg_op = 'UPDATE' and new.organisation_id <> old.organisation_id then raise exception 'job guard: organisation never changes' using errcode = 'P0001'; end if;
    -- 0019 (D8, #227): every portal write names an active poster, recruiter or account owner of the job's own company
    if not exists (select 1 from membership m where m.id = new.posted_by_membership_id and m.organisation_id = new.organisation_id
        and m.status = 'active' and m.role in ('poster','recruiter','account_owner')) then
      raise exception 'job guard: the portal writes a job only for an active poster, recruiter or account owner of its company' using errcode = 'P0001'; end if;
    if new.badge is not null and new.badge <> 'sponsor_confirmed' then raise exception 'job guard: the portal sets only sponsor_confirmed or no badge' using errcode = 'P0001'; end if;
    if new.pass_route is not null and new.pass_route not in ('stated_pay','public_pay') then raise exception 'job guard: the portal sets pass_route only to stated_pay or public_pay' using errcode = 'P0001'; end if;
    if new.pay_floor_id is not null then raise exception 'job guard: the portal sets no pay floor' using errcode = 'P0001'; end if;
    if new.closes_at > now() + interval '30 days' then raise exception 'job guard: closes_at at most 30 days ahead' using errcode = 'P0001'; end if;
    -- 0028 (#244 a): the client was not found in the DETE names (set by job_defaults, which runs first)
    held := new.permit_employer_kind = 'client' and new.permit_employer_check = 'not_found';
    if new.status is distinct from from_status then
      if from_status = 'draft' and new.status = 'live' then
        if restricted or held then new.status := 'in_review'; end if; -- the guard changes the status, it does not refuse (#44)
        if held then perform set_config('app.client_hold_job', new.id::text, true); end if; -- read by job_queue_review: held for the client only
      elsif from_status = 'draft' and new.status = 'in_review' then null;
      elsif from_status in ('draft','in_review','live','under_review') and new.status = 'closed' then null;
      elsif from_status = 'live' and new.status = 'under_review' and tg_op = 'UPDATE' then null; -- 0044 (P14, #254): a renewal that no longer passes the rules
      -- 0045 (gap 1): a job a renewal moved for a non-pay rule goes back live on an update that changes a field the rules read (the portal runs them first)
      elsif from_status = 'under_review' and new.status = 'live' and tg_op = 'UPDATE' and old.under_review_reason is distinct from 'pay_check'
        and row(new.title, new.occupation_code, new.contract_type, new.contract_months, new.permit_type, new.salary_low, new.salary_high, new.pay_grade, new.health_insurance_eur,
                new.weekly_hours, new.county, new.permit_employer_kind, new.permit_employer_name, new.badge, new.search_vector)
          is distinct from row(old.title, old.occupation_code, old.contract_type, old.contract_months, old.permit_type, old.salary_low, old.salary_high, old.pay_grade, old.health_insurance_eur,
                old.weekly_hours, old.county, old.permit_employer_kind, old.permit_employer_name, old.badge, old.search_vector) then null;
      elsif from_status = 'under_review' and new.status = 'live' and tg_op = 'UPDATE'
        and row(new.salary_low, new.salary_high, new.pay_grade, new.health_insurance_eur) is distinct from row(old.salary_low, old.salary_high, old.pay_grade, old.health_insurance_eur) then null;
      else raise exception 'job guard: the portal may not move a job from % to %', from_status, new.status using errcode = 'P0001';
      end if;
    end if;
    -- 0028: a job that stays (or goes back) live may not name a new client that is not found; staff approved only the client it had
    if held and new.status = 'live' and tg_op = 'UPDATE' and row(new.permit_employer_kind, new.permit_employer_name) is distinct from row(old.permit_employer_kind, old.permit_employer_name) then
      raise exception 'job guard: a client not found in the DETE names needs staff review' using errcode = 'P0001'; end if;
  elsif current_user = 'app_fetcher' then
    if new.source <> 'fetched' then raise exception 'job guard: the fetcher writes only fetched jobs' using errcode = 'P0001'; end if;
    if new.badge is not null and new.badge <> 'critical_skills_eligible' then raise exception 'job guard: the fetcher sets only critical_skills_eligible' using errcode = 'P0001'; end if;
    if tg_op = 'UPDATE' and old.status in ('hidden','in_review') and new.status <> old.status then raise exception 'job guard: the fetcher never moves a job out of % ', old.status using errcode = 'P0001'; end if;
    -- F1: a job staff closed (removed, under_review_expired) never comes back. Only a job that expired or that the fetcher closed itself reopens, and only to live.
    if tg_op = 'UPDATE' and old.status = 'closed' and new.status <> 'closed' and not (new.status = 'live' and coalesce(old.close_reason, '') in ('expired','closed','recheck_failed','source_stale')) then
      raise exception 'job guard: the fetcher never reopens a closed job unless it expired or the fetcher closed it' using errcode = 'P0001'; end if;
    -- and a closed job keeps its reason while it stays closed, or a removed job could be relabelled 'closed' first and reopened second
    if tg_op = 'UPDATE' and old.status = 'closed' and new.status = 'closed' and new.close_reason is distinct from old.close_reason then
      raise exception 'job guard: the fetcher never changes the close reason of a closed job' using errcode = 'P0001'; end if;
    -- F4: no way back to draft, so the move into live that sets posted_at happens once
    if tg_op = 'UPDATE' and new.status = 'draft' and old.status <> 'draft' then raise exception 'job guard: the fetcher never moves a job back to draft' using errcode = 'P0001'; end if;
  end if;
  -- every role: posted_at is now() on each move into live from draft or in_review (an insert straight to live included)
  if new.status = 'live' and from_status in ('draft','in_review') and (tg_op = 'INSERT' or old.status <> 'live') then new.posted_at := now(); end if;
  return new;
end $$;

reset role;
