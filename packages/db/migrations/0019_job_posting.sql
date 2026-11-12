-- Employer job posting (step 9 part 12a; #44, #48, #49, #224 to #227). Four things:
--   1. job.weekly_hours: the hours a post states (DETE's minimums assume a 39-hour week), so the pay check can be repeated.
--   2. One job_source row that every employer and agency post points to (job.job_source_id is not null; the portal may only read job_source).
--   3. D8 (#227): private.job_guard copied whole from its newest version (0006_fetcher_changes.sql) with one addition: a portal write needs
--      posted_by_membership_id to be an active Poster, Recruiter or account owner membership of the job's company. The route sets it to the
--      acting login's own membership on every write; the guard is the final word when that membership was changed meanwhile.
--   4. private.portal_jobs (the company's own job list with the reason a job is held, #44) for app_portal, and D7 private.expire_employer_jobs
--      (close at day 30 with 'expired', one reminder 3 days before, #48) for app_admin, run daily from .github/workflows/daily-fetch.yml.
set role portal_owner;

alter table job add column weekly_hours smallint check (weekly_hours between 1 and 60);
grant select (weekly_hours), insert (weekly_hours), update (weekly_hours) on job to app_portal;

insert into job_source(kind, board) values ('portal', 'employer') on conflict (kind, board) do nothing;

create or replace function private.job_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare from_status text; restricted boolean;
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
    if new.status is distinct from from_status then
      if from_status = 'draft' and new.status = 'live' then
        if restricted then new.status := 'in_review'; end if; -- the guard changes the status, it does not refuse (#44)
      elsif from_status = 'draft' and new.status = 'in_review' then null;
      elsif from_status in ('draft','in_review','live','under_review') and new.status = 'closed' then null;
      elsif from_status = 'under_review' and new.status = 'live' and tg_op = 'UPDATE'
        and row(new.salary_low, new.salary_high, new.pay_grade, new.health_insurance_eur) is distinct from row(old.salary_low, old.salary_high, old.pay_grade, old.health_insurance_eur) then null;
      else raise exception 'job guard: the portal may not move a job from % to %', from_status, new.status using errcode = 'P0001';
      end if;
    end if;
  elsif current_user = 'app_fetcher' then
    if new.source <> 'fetched' then raise exception 'job guard: the fetcher writes only fetched jobs' using errcode = 'P0001'; end if;
    if new.badge is not null and new.badge <> 'critical_skills_eligible' then raise exception 'job guard: the fetcher sets only critical_skills_eligible' using errcode = 'P0001'; end if;
    if tg_op = 'UPDATE' and old.status in ('hidden','in_review') and new.status <> old.status then raise exception 'job guard: the fetcher never moves a job out of % ', old.status using errcode = 'P0001'; end if;
    -- F1: a job staff closed (removed, under_review_expired) never comes back. Only a job that expired or that the fetcher closed itself reopens, and only to live.
    if tg_op = 'UPDATE' and old.status = 'closed' and new.status <> 'closed' and not (new.status = 'live' and coalesce(old.close_reason, '') in ('expired','closed','recheck_failed')) then
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


-- The company's own jobs, newest first, for any active member (private.status_member from 0017 checks the login and finds its membership).
-- reason: why a job is held (#44): in_review 'restricted_company' (a strike-2 company's new job, post_strike_job_review) or 'staff_check';
-- under_review 'pay_check'; hidden its hidden_reason ('report', 'organisation_suspended', 'admin'). clientCheck: an open agency_client_check
-- (the client was not found in the DETE names). Never staff ids, report ids or review notes.
-- ponytail: the newest 200 only; add a cursor when a company holds more.
create function private.portal_jobs(p_user text) returns jsonb
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
        when 'under_review' then 'pay_check'
        when 'hidden' then j.hidden_reason end,
      'clientCheck', exists (select 1 from review_item r where r.job_id = j.id and r.queue = 'agency_client_check' and r.status in ('open','claimed'))) as j
    from job j where j.organisation_id = m.organisation_id and j.source in ('employer','agency')
    order by j.posted_at desc, j.id desc limit 200) x), '[]'::jsonb);
end $$;

-- D7 (#48): employer and agency jobs past closes_at close: live and in_review ones as 'expired', under_review ones as 'under_review_expired'
-- (the reason the schema keeps for them). Hidden jobs stay hidden (a report is open) and drafts are left to retention. Then one reminder
-- per live job whose end is within 3 days goes to the outbox, to the member who last wrote it if still active, else the account owner.
-- The dedupe key holds closes_at, so a renewed job is reminded again before its new end and a second run the same day adds nothing.
-- Returns how many jobs closed and how many reminders were queued.
create function private.expire_employer_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare closed integer; reminded integer;
begin
  with c as (
    update job set status = 'closed', closed_at = now(), close_reason = case when status = 'under_review' then 'under_review_expired' else 'expired' end
     where source in ('employer','agency') and status in ('live','in_review','under_review') and closes_at <= now() returning 1)
  select count(*) into closed from c;
  with r as (
    insert into email_outbox(template, portal_user_id, params, dedupe_key)
    select 'job_expiry_reminder', u.id, jsonb_build_object('jobId', j.id, 'closesAt', j.closes_at), 'job_expiry_reminder:' || j.id || ':' || extract(epoch from j.closes_at)::bigint
      from job j cross join lateral (
        select coalesce(
          (select p.portal_user_id from membership p where p.id = j.posted_by_membership_id and p.status = 'active'),
          (select o.portal_user_id from membership o where o.organisation_id = j.organisation_id and o.role = 'account_owner' and o.status = 'active')) as id) u
     where j.source in ('employer','agency') and j.status = 'live' and j.closes_at > now() and j.closes_at <= now() + interval '3 days' and u.id is not null
    on conflict (dedupe_key) do nothing returning 1)
  select count(*) into reminded from r;
  return jsonb_build_object('closed', closed, 'reminded', reminded);
end $$;

grant execute on function private.portal_jobs(text) to app_portal;
grant execute on function private.expire_employer_jobs() to app_admin;

reset role;
