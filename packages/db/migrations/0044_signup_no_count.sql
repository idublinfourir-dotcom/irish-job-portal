-- Step 15, audit row C5 (#253): how many visitors answer "no" to the sign-up question "Do you need a work permit?" (#8). One number per UTC day and
-- nothing else: no address, no IP, no user agent, nothing that could identify the visitor. The candidate sign-up route adds one (packages/auth/src/signup.ts,
-- COUNT_NO) after Better Auth's per-IP limit and the bot check; staff read the days through GET /api/signup-no-counts.
--
-- Audit row P14 (#254): private.job_guard is copied whole from 0035 with one more move for the portal, live to under_review, made by a one-click
-- renewal whose job no longer passes the rules in force (apps/portal/lib/jobs.ts, jobRenew). Back to live needs a pay edit that passes, as for #93.
set role portal_owner;

create table signup_no_count (
  day date primary key,
  count integer not null check (count > 0)
);
-- select: the upsert reads the old count
grant select, insert, update (count) on signup_no_count to app_candidate;
grant select on signup_no_count to app_admin;

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
