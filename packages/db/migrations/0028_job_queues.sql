-- Step 15 Q1 (#244): the staff queues for held employer and agency jobs (scam_flag, post_strike_job_review, agency_client_check). Four things:
--   1. #244 (a): an employer or agency job whose client is not in the DETE names (permit_employer_kind 'client', permit_employer_check 'not_found')
--      is held in review until staff check it. private.job_guard is copied whole from 0019 with two additions in the app_portal branch: a move from
--      draft to live (an insert straight to live included) becomes in_review, as for a restricted company (#44); and an edit that keeps a job live,
--      or moves it back to live, while naming a different client that is not found is refused ("job guard: a client not found", the portal's
--      NEEDS_REVIEW). The check is computed before the guard runs: triggers of one event fire in name order, and job_defaults sorts before job_guard.
--   2. job_defaults also fires on an update of permit_employer_check, so the portal cannot write 'found' on a client job by itself.
--   3. private.job_queue_review: a job held only for its client gets its agency_client_check item, not also a scam_flag item (the guard marks the
--      job in app.client_hold_job for the rest of the transaction; when the portal itself asked for in_review the rules flagged it and both are
--      right). agency_client_check is queued only for a job past draft, never for a draft. A job that closes (the portal, the 30-day close, a
--      staff reject) drops its open and claimed items of the three queues, outcome 'job_closed'.
--   4. No grant changes: app_admin already reads and writes review_item and job; app_portal still cannot write review_item.
set role portal_owner;

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

drop trigger job_defaults on job;
create trigger job_defaults before insert or update of permit_employer_kind, permit_employer_name, permit_employer_check on job for each row execute function private.job_defaults();

create or replace function private.job_queue_review() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare client_held boolean := new.permit_employer_kind = 'client' and new.permit_employer_check = 'not_found';
begin
  if new.status = 'in_review' and (tg_op = 'INSERT' or old.status <> 'in_review') then
    if new.source = 'fetched' then
      insert into review_item(queue, job_id, reason) values ('fetched_job', new.id, 'queued fetched advert') on conflict do nothing;
    elsif new.source in ('employer','agency') then
      if exists (select 1 from organisation o where o.id = new.organisation_id and o.restricted_until > now()) then
        insert into review_item(queue, job_id, reason) values ('post_strike_job_review', new.id, 'restricted organisation') on conflict do nothing;
      elsif not (client_held and current_setting('app.client_hold_job', true) = new.id::text) then
        insert into review_item(queue, job_id, reason) values ('scam_flag', new.id, 'employer or agency job in review') on conflict do nothing;
      end if;
    end if;
  end if;
  if client_held and new.status not in ('draft','closed')
     and (tg_op = 'INSERT' or old.status = 'draft' or old.permit_employer_check is distinct from 'not_found') then
    insert into review_item(queue, job_id, reason) values ('agency_client_check', new.id, 'client not found in DETE') on conflict do nothing;
  end if;
  if tg_op = 'UPDATE' and new.status = 'closed' and old.status <> 'closed' then
    update review_item set status = 'dropped', outcome = 'job_closed', decided_at = now()
     where job_id = new.id and queue in ('scam_flag','post_strike_job_review','agency_client_check') and status in ('open','claimed');
  end if;
  return null;
end $$;

reset role;
