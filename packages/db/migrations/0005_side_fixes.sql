-- Side fixes (review of the fetcher and the candidate site, 10 November 2026, findings F1 to F4 and F6 to F9). Closes each hole in the database,
-- not in app code. Applied migrations stay as they are: functions are replaced here and grants are revoked and granted again.
set role portal_owner;

-- ===== F1 and F4: the fetcher and closed or draft jobs (job_guard replaced, fetcher branch only)
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
    if tg_op = 'UPDATE' and old.status = 'closed' and new.status <> 'closed' and not (new.status = 'live' and coalesce(old.close_reason, '') in ('expired','closed')) then
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

-- ===== F2: the fetcher inserts only scam flags, with only the columns a flag needs (status stays 'open' by default)
revoke insert on review_item from app_fetcher;
grant insert (queue, job_id, reason, detail) on review_item to app_fetcher;
create function private.review_item_fetcher() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_fetcher' and new.queue <> 'scam_flag' then
    raise exception 'review item guard: the fetcher inserts only scam_flag items' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger review_item_fetcher before insert on review_item for each row execute function private.review_item_fetcher();

-- ===== F3: advert text is written only for the jobs a role owns (invoker's rights, like job_guard)
create function private.job_text_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare src text;
begin
  if current_user in ('app_fetcher', 'app_portal') then
    if tg_op = 'UPDATE' and new.job_id <> old.job_id then raise exception 'job text guard: job_id never changes' using errcode = 'P0001'; end if;
    select j.source into src from job j where j.id = case when tg_op = 'DELETE' then old.job_id else new.job_id end;
    if current_user = 'app_fetcher' and src is distinct from 'fetched' then
      raise exception 'job text guard: the fetcher writes only the text of fetched jobs' using errcode = 'P0001'; end if;
    if current_user = 'app_portal' and src not in ('employer', 'agency') then
      raise exception 'job text guard: the portal writes only the text of employer and agency jobs' using errcode = 'P0001'; end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger job_text_guard before insert or update or delete on job_text for each row execute function private.job_text_guard();

-- ===== F6: the tracker guard decides on the old route, so changing the route in the same update does not skip it
create or replace function private.tracker_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_candidate' then
    if tg_op = 'INSERT' and new.route = 'on_site' and new.stage <> 'applied' then raise exception 'tracker guard: an on-site row starts at applied' using errcode = 'P0001'; end if;
    if tg_op = 'UPDATE' and (old.route = 'on_site' or new.route = 'on_site') and (old.route <> new.route or (new.stage is distinct from old.stage and new.stage <> 'withdrawn')) then
      raise exception 'tracker guard: on an on-site row the candidate may only set withdrawn' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;

-- ===== F7: a document or a case names only rows of the same person (owner's rights: the roles cannot read services_case or consent_record)
create function private.case_document_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if num_nonnulls(new.candidate_user_id, new.portal_user_id) = 1 and not exists (
    select 1 from services_case s where s.id = new.services_case_id
       and s.candidate_user_id is not distinct from new.candidate_user_id and s.portal_user_id is not distinct from new.portal_user_id) then
    raise exception 'case document guard: a document goes only on a case of the same person' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger case_document_guard before insert or update of services_case_id, candidate_user_id, portal_user_id on case_document for each row execute function private.case_document_guard();
create function private.services_case_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare k bigint;
begin
  if num_nonnulls(new.candidate_user_id, new.portal_user_id) = 1 then
    foreach k in array array[new.consent_record_id, new.employer_contact_consent_record_id] loop
      if k is not null and not exists (
        select 1 from consent_record c where c.id = k
           and c.candidate_user_id is not distinct from new.candidate_user_id and c.portal_user_id is not distinct from new.portal_user_id) then
        raise exception 'services case guard: a case rests only on consent records of the same person' using errcode = 'P0001'; end if;
    end loop;
  end if;
  return new;
end $$;
create trigger services_case_guard before insert or update of consent_record_id, employer_contact_consent_record_id, candidate_user_id, portal_user_id on services_case
  for each row execute function private.services_case_guard();

-- ===== F8: consent proof. given_at is the default now() (out of the insert grants), and an app role only sets withdrawn_at, once, to now().
revoke insert (given_at) on candidate_consent_record from app_candidate;
revoke insert (given_at) on portal_consent_record from app_portal;
create function private.consent_record_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('app_candidate', 'app_portal', 'app_admin', 'app_fetcher')
     and (old.withdrawn_at is not null or new.withdrawn_at is distinct from now()) then
    raise exception 'consent guard: withdrawn_at goes only from empty to now()' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger consent_record_guard before update of withdrawn_at on consent_record for each row execute function private.consent_record_guard();

-- ===== F9: an app role never sets last_active_at in the future (insert and update).
-- Five minutes of room, because an app may send its own clock's time and that clock can run a little ahead of the database's.
create function private.last_active_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('app_candidate', 'app_portal', 'app_admin', 'app_fetcher') and new.last_active_at > now() + interval '5 minutes' then
    raise exception 'last_active_at guard: last_active_at is never later than now' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger last_active_guard before insert or update of last_active_at on candidate_user for each row execute function private.last_active_guard();

reset role;
