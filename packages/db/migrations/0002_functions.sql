-- Functions and triggers (design 23). Final state: the build plus every proven fix.
set role portal_owner;

-- Views, the callable functions and the trigger functions, as sections 2, 2.1 and the tables describe them (trial 3: brought up to the 980-line design).
-- Run as portal_owner. Callable functions and trigger functions live in `private`.

-- ===== Per-side views (section 2) and the published content view (section 6)
create view candidate_services_case with (security_barrier) as select * from services_case where candidate_user_id is not null with cascaded check option;
create view portal_services_case with (security_barrier) as select * from services_case where portal_user_id is not null with cascaded check option;
create view candidate_case_document with (security_barrier) as select * from case_document where candidate_user_id is not null with cascaded check option;
create view portal_case_document with (security_barrier) as select * from case_document where portal_user_id is not null with cascaded check option;
create view candidate_consent_record with (security_barrier) as select * from consent_record where candidate_user_id is not null with cascaded check option;
create view portal_consent_record with (security_barrier) as select * from consent_record where portal_user_id is not null with cascaded check option;
create view candidate_notification with (security_barrier) as select * from notification where candidate_user_id is not null with cascaded check option;
create view portal_notification with (security_barrier) as select * from notification where portal_user_id is not null with cascaded check option;
create view candidate_notification_preference with (security_barrier) as select * from notification_preference where candidate_user_id is not null with cascaded check option;
create view portal_notification_preference with (security_barrier) as select * from notification_preference where portal_user_id is not null with cascaded check option;
create view published_content_page with (security_barrier) as
  select id, kind, slug, title, body, source_url, checked_on, published_at, updated_at from content_page where status = 'published' with cascaded check option;


-- ===== Two-person rule: one helper and one trigger function for every table that points to approval_request
-- p_role is new (grant_role): the request's change must name the role being granted. PICK: the change jsonb names it as {"role": "..."}.
create function private.use_approval(p_request bigint, p_kind text, p_table text, p_target text, p_role text default null) returns bigint
language plpgsql set search_path = public, pg_temp as $$
declare r approval_request;
begin
  if p_request is null then
    select * into r from approval_request where kind = p_kind and target_table = p_table and target_id = p_target
      and status = 'confirmed' and applied_at is null and (p_role is null or change->>'role' = p_role) order by id limit 1 for update;
  else
    select * into r from approval_request where id = p_request for update;
  end if;
  if r.id is null then raise exception 'two-person rule: no confirmed % request for %/%', p_kind, p_table, p_target using errcode = 'P0001'; end if;
  if r.status <> 'confirmed' then raise exception 'two-person rule: request % is %, not confirmed', r.id, r.status using errcode = 'P0001'; end if;
  if r.kind <> p_kind then raise exception 'two-person rule: request % is of kind %, needs %', r.id, r.kind, p_kind using errcode = 'P0001'; end if;
  if r.target_table <> p_table or r.target_id <> p_target then
    raise exception 'two-person rule: request % is for %/%, not %/%', r.id, r.target_table, r.target_id, p_table, p_target using errcode = 'P0001'; end if;
  if p_role is not null and r.change->>'role' is distinct from p_role then
    raise exception 'two-person rule: request % does not name the role %', r.id, p_role using errcode = 'P0001'; end if;
  if r.applied_at is not null then raise exception 'two-person rule: request % was already used at %', r.id, r.applied_at using errcode = 'P0001'; end if;
  update approval_request set applied_at = now() where id = r.id;
  return r.id;
end $$;
create function private.approval_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s strike; at timestamptz;
begin
  case tg_table_name
  when 'staff_role' then
    -- every role needs a confirmed request unless the owner seeded it (#136 c)
    if tg_op = 'INSERT' and not new.seeded_by_owner then
      perform private.use_approval(new.approval_request_id, case when new.role = 'administrator' then 'grant_administrator' else 'grant_role' end,
                                   'staff_role', new.staff_user_id, case when new.role = 'administrator' then null else new.role end); end if;
  when 'ban' then
    if tg_op = 'UPDATE' then raise exception 'ban: no role updates a ban row; a correction is a confirmed ban_lift and a new case' using errcode = 'P0001'; end if;
    if tg_op = 'DELETE' then
      perform private.use_approval(null, 'ban_lift', 'ban', old.id::text);
      update strike set ban_lifted_at = now() where id = old.strike_id;
      return old;
    end if;
    -- a ban shares its strike case's request: it is checked once, on the strike row; here it must be that request, applied in this transaction
    select * into s from strike where id = new.strike_id;
    if s.id is null or not (s.outcome = 'ban' or (s.outcome = 'strike' and s.level = 3)) then
      raise exception 'ban refused: the case must have outcome ban or level 3' using errcode = 'P0001'; end if;
    if new.approval_request_id is distinct from s.approval_request_id then
      raise exception 'ban refused: it must use the strike case''s approval request' using errcode = 'P0001'; end if;
    select applied_at into at from approval_request where id = new.approval_request_id;
    if at is distinct from now() then raise exception 'ban refused: the request was not applied in this transaction' using errcode = 'P0001'; end if;
  when 'strike' then
    if ((new.outcome = 'strike' and new.level in (2,3)) or new.outcome = 'ban') and (tg_op = 'INSERT' or old.outcome is distinct from new.outcome
        or old.level is distinct from new.level or old.approval_request_id is distinct from new.approval_request_id) then
      perform private.use_approval(new.approval_request_id, case when new.outcome = 'ban' then 'ban' when new.level = 2 then 'strike_2' else 'strike_3' end, 'strike', new.id::text);
    end if;
  when 'pay_floor' then
    if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or old.approval_request_id is distinct from new.approval_request_id) then
      perform private.use_approval(new.approval_request_id, 'pay_floor', 'pay_floor', new.id::text); end if;
  when 'sponsorship_statement' then
    if new.kind = 'admin_on_behalf' then perform private.use_approval(new.approval_request_id, 'manual_post_sponsor_confirmed', 'sponsorship_statement', new.job_id::text); end if;
  when 'consent_text' then
    if new.purpose in ('signup_terms','privacy_notice') then perform private.use_approval(new.approval_request_id, 'terms_privacy_page', 'consent_text', new.purpose || ':' || new.version); end if;
  when 'organisation' then
    if new.is_big_company and (tg_op = 'INSERT' or not old.is_big_company) then perform private.use_approval(null, 'big_company_entry', 'organisation', new.id::text); end if;
  end case;
  return new;
end $$;
create trigger staff_role_approval before insert or update on staff_role for each row execute function private.approval_check();
create trigger ban_approval before insert or update or delete on ban for each row execute function private.approval_check();
create trigger strike_approval before insert or update on strike for each row execute function private.approval_check();
create trigger pay_floor_approval before insert or update on pay_floor for each row execute function private.approval_check();
create trigger sponsorship_statement_approval before insert on sponsorship_statement for each row execute function private.approval_check();
create trigger consent_text_approval before insert on consent_text for each row execute function private.approval_check();
create trigger organisation_big_company_approval before insert or update of is_big_company on organisation for each row execute function private.approval_check();

-- approval_request itself (section 6, Access): every new row is pending with the proposer stamped from the acting staff id; a confirmation
-- stamps the confirmer and the time; status moves only from pending; applied_at changes once, from empty to now(). Every role, owner's rights.
-- The acting id is `set local app.staff_user_id` (section 2). PICK: a move to withdrawn needs no acting staff member (the design lists only new rows, confirmed and refused).
create function private.approval_request_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare staff text := nullif(current_setting('app.staff_user_id', true), '');
begin
  if tg_op = 'INSERT' or (new.status is distinct from old.status and new.status in ('confirmed','refused')) then
    if staff is null or not exists (select 1 from staff_user u where u.id = staff and u.status = 'active') then
      raise exception 'approval_request: no acting staff member (set local app.staff_user_id to an active staff user)' using errcode = 'P0001'; end if;
    if not exists (select 1 from staff_role r where r.staff_user_id = staff) then
      raise exception 'approval_request: the acting staff member holds no role' using errcode = 'P0001'; end if;
  end if;
  if tg_op = 'INSERT' then
    new.status := 'pending'; new.proposed_by_staff_user_id := staff; new.confirmed_by_staff_user_id := null; new.decided_at := null; new.applied_at := null;
    return new;
  end if;
  if new.applied_at is distinct from old.applied_at and (old.applied_at is not null or new.applied_at is distinct from now()) then
    raise exception 'approval_request: applied_at changes once, from empty to now()' using errcode = 'P0001'; end if;
  if new.status is distinct from old.status then
    if old.status <> 'pending' or new.status not in ('confirmed','refused','withdrawn') then
      raise exception 'approval_request: status changes only from pending, to confirmed, refused or withdrawn' using errcode = 'P0001'; end if;
    if new.status in ('confirmed','refused') then new.confirmed_by_staff_user_id := staff; new.decided_at := now(); end if;
  end if;
  return new;
end $$;
create trigger approval_request_guard before insert or update on approval_request for each row execute function private.approval_request_guard();

-- ===== Job: defaults, write guard (current_user, so SECURITY DEFINER callers pass), live check, queue and deferred statement check
-- Owner's rights: permit_history is copied from the organisation on insert whatever the role sends; permit_employer_check is computed
-- for a client job (the value the portal sends is ignored). PICK: "after cleaning" = lower case, every run of non-alphanumerics to one space, trimmed,
-- compared with organisation_name.normalised_name. PICK: for a self job the check is left as sent (default pending).
create function private.job_defaults() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare nid bigint;
begin
  if tg_op = 'INSERT' then select o.permit_history into new.permit_history from organisation o where o.id = new.organisation_id; end if;
  if new.permit_employer_kind = 'client' then
    select n.id into nid from organisation_name n
     where n.normalised_name = btrim(regexp_replace(lower(coalesce(new.permit_employer_name, '')), '[^a-z0-9]+', ' ', 'g')) order by (n.kind = 'legal') desc, n.id limit 1;
    new.permit_employer_name_id := nid;
    new.permit_employer_check := case when nid is null then 'not_found' else 'found' end;
  end if;
  return new;
end $$;
create trigger job_defaults before insert or update of permit_employer_kind, permit_employer_name on job for each row execute function private.job_defaults();
create function private.job_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
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
  end if;
  -- every role: posted_at is now() on each move into live from draft or in_review (an insert straight to live included)
  if new.status = 'live' and from_status in ('draft','in_review') and (tg_op = 'INSERT' or old.status <> 'live') then new.posted_at := now(); end if;
  return new;
end $$;
create trigger job_guard before insert or update on job for each row execute function private.job_guard();
create function private.job_org_live() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare st text;
begin
  if new.status = 'live' and (tg_op = 'INSERT' or old.status <> 'live') then
    select status into st from organisation where id = new.organisation_id;
    if st in ('suspended','banned','closed') then raise exception 'job refused: the organisation is suspended, banned or closed' using errcode = 'P0001'; end if;
    if new.source in ('employer','agency') and st not in ('verified','verified_restricted') then
      raise exception 'job refused: the organisation is not verified' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
create trigger job_org_live before insert or update of status on job for each row execute function private.job_org_live();
create function private.job_queue_review() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'in_review' and (tg_op = 'INSERT' or old.status <> 'in_review') then
    if new.source = 'fetched' then
      insert into review_item(queue, job_id, reason) values ('fetched_job', new.id, 'queued fetched advert') on conflict do nothing;
    elsif new.source in ('employer','agency') then
      if exists (select 1 from organisation o where o.id = new.organisation_id and o.restricted_until > now()) then
        insert into review_item(queue, job_id, reason) values ('post_strike_job_review', new.id, 'restricted organisation') on conflict do nothing;
      else
        insert into review_item(queue, job_id, reason) values ('scam_flag', new.id, 'employer or agency job in review') on conflict do nothing;
      end if;
    end if;
  end if;
  if new.permit_employer_kind = 'client' and new.permit_employer_check = 'not_found' and (tg_op = 'INSERT' or old.permit_employer_check <> 'not_found') then
    insert into review_item(queue, job_id, reason) values ('agency_client_check', new.id, 'client not found in DETE') on conflict do nothing;
  end if;
  return null;
end $$;
create trigger job_queue_review after insert or update of status, permit_employer_check on job for each row execute function private.job_queue_review();
create function private.job_sponsor_statement() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare jid bigint;
begin
  if tg_table_name = 'job' then jid := new.id; else jid := old.job_id; end if;
  if exists (select 1 from job j where j.id = jid and j.status = 'live' and j.badge = 'sponsor_confirmed')
     and not exists (select 1 from sponsorship_statement s where s.job_id = jid and s.superseded_at is null) then
    raise exception 'deferred check: live job % shows sponsor_confirmed with no current sponsorship statement', jid using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger job_sponsor_statement after insert or update on job deferrable initially deferred for each row execute function private.job_sponsor_statement();
create constraint trigger statement_sponsor_statement after update or delete on sponsorship_statement deferrable initially deferred for each row execute function private.job_sponsor_statement();
-- Removal closes (job, hidden_reason): in the same transaction as the decision. PICK: done by triggers on report, strike and ban, not left to app code.
create function private.close_job_removed(p_where_org bigint, p_job bigint, p_report bigint) returns void language sql security definer set search_path = public, pg_temp as $$
  update job set status = 'closed', closed_at = now(), close_reason = 'removed', hidden_reason = null, hidden_report_id = null
   where status <> 'closed' and ((p_where_org is not null and organisation_id = p_where_org) or id = p_job or (p_report is not null and hidden_report_id = p_report))
$$;
create function private.report_upheld() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.status = 'upheld' and old.status is distinct from 'upheld' then perform private.close_job_removed(null, null, new.id); end if;
  return null;
end $$;
create trigger report_upheld after update of status on report for each row execute function private.report_upheld();
create function private.strike_closes_jobs() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.outcome = 'strike' and new.level = 1 and new.job_id is not null and (tg_op = 'INSERT' or old.outcome is distinct from new.outcome or old.level is distinct from new.level) then
    perform private.close_job_removed(null, new.job_id, null); end if;
  return null;
end $$;
create trigger strike_closes_jobs after insert or update of outcome, level on strike for each row execute function private.strike_closes_jobs();
create function private.ban_closes_jobs() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.close_job_removed((select organisation_id from strike where id = new.strike_id), null, null);
  return null;
end $$;
create trigger ban_closes_jobs after insert on ban for each row execute function private.ban_closes_jobs();
-- ===== Signers, pay floors
create function private.signer_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.signer_membership_id is not null and not exists (select 1 from membership m where m.id = new.signer_membership_id
      and m.organisation_id = new.organisation_id and m.status = 'active' and ((m.is_signer and m.role in ('poster','recruiter')) or m.role = 'account_owner')) then
    raise exception 'signer refused: not an active poster or recruiter with the signer switch, or the account owner (a viewer never signs)' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger sponsorship_statement_signer before insert on sponsorship_statement for each row execute function private.signer_check();
create trigger pay_floor_signer before insert on pay_floor for each row execute function private.signer_check();
create function private.pay_floor_insert() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and tg_when = 'BEFORE' then
    if not exists (select 1 from organisation o where o.id = new.organisation_id and o.kind = 'employer' and o.is_big_company) then
      raise exception 'pay floor refused: the organisation is not an employer on the big-company list' using errcode = 'P0001'; end if;
    return new;
  end if;
  insert into review_item(queue, pay_floor_id, reason) values ('pay_floor_check', new.id, 'new floor') on conflict do nothing;
  return null;
end $$;
create trigger pay_floor_big_company before insert on pay_floor for each row execute function private.pay_floor_insert();
create trigger pay_floor_queue after insert on pay_floor for each row execute function private.pay_floor_insert();
create function private.pay_floor_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_portal' and new.status is distinct from old.status and not (old.status in ('pending_check','active') and new.status = 'withdrawn') then
    raise exception 'pay floor guard: the portal may only withdraw a pending or active floor' using errcode = 'P0001';
  end if;
  if old.status in ('pending_check','active') and new.status not in ('pending_check','active') and new.ended_at is null then
    new.ended_at := now(); -- the guard trigger sets it when status leaves pending_check or active
  end if;
  return new;
end $$;
create trigger pay_floor_guard before update on pay_floor for each row execute function private.pay_floor_guard();
-- A statement's kind matches job.source and the inserting role (current_user): staff cannot sign for an employer (#104).
create function private.statement_kind_check() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare src text;
begin
  select source into src from job where id = new.job_id;
  if new.kind = 'admin_on_behalf' then
    if src is distinct from 'admin_manual' or current_user <> 'app_admin' then raise exception 'statement refused: admin_on_behalf goes only on an admin_manual job, inserted by app_admin' using errcode = 'P0001'; end if;
  elsif src is null or src not in ('employer','agency') or current_user <> 'app_portal' then
    raise exception 'statement refused: % goes only on an employer or agency job, inserted by app_portal', new.kind using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger sponsorship_statement_kind before insert on sponsorship_statement for each row execute function private.statement_kind_check();

-- ===== Candidate side guards and Launch B triggers
create function private.tracker_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_candidate' and new.route = 'on_site' then
    if tg_op = 'INSERT' and new.stage <> 'applied' then raise exception 'tracker guard: an on-site row starts at applied' using errcode = 'P0001'; end if;
    if tg_op = 'UPDATE' and (old.route <> new.route or (new.stage is distinct from old.stage and new.stage <> 'withdrawn')) then
      raise exception 'tracker guard: on an on-site row the candidate may only set withdrawn' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
create trigger tracker_guard before insert or update on tracker_entry for each row execute function private.tracker_guard();
create function private.application_job_open() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from job j where j.id = new.job_id and j.status = 'live' and j.closes_at > now() and j.application_route = 'on_site') then
    raise exception 'application refused: the job is closed, hidden, expired or not on-site' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger application_job_open before insert on application for each row execute function private.application_job_open();
create function private.application_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_candidate' and (new.status is distinct from old.status) and new.status <> 'withdrawn' then
    raise exception 'application guard: the candidate may only withdraw' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger application_guard before update on application for each row execute function private.application_guard();
create function private.contact_request_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare lim integer; wait_days integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('contact_request:' || new.organisation_id, 0));
  if not exists (select 1 from candidate_profile p join candidate_user u on u.id = p.candidate_user_id
      where p.candidate_user_id = new.candidate_user_id and p.visible_to_employers and u.suspended_at is null and u.deleted_at is null) then
    raise exception 'contact request refused: the candidate is not visible, or is suspended or deleted' using errcode = 'P0001'; end if;
  if exists (select 1 from candidate_hidden_organisation h where h.candidate_user_id = new.candidate_user_id and h.organisation_id = new.organisation_id) then
    raise exception 'contact request refused: the candidate has hidden this organisation' using errcode = 'P0001'; end if;
  select value into lim from setting where key = 'contact_requests_per_day';
  if lim is not null and (select count(*) from contact_request c where c.organisation_id = new.organisation_id
      and c.sent_at >= (date_trunc('day', now() at time zone 'Europe/Dublin') at time zone 'Europe/Dublin')) >= lim then -- PICK: calendar day in Dublin
    raise exception 'contact request refused: the organisation reached % requests today', lim using errcode = 'P0001'; end if;
  select value into wait_days from setting where key = 'contact_request_reask';
  if wait_days is not null and exists (select 1 from contact_request c where c.organisation_id = new.organisation_id and c.candidate_user_id = new.candidate_user_id
      and c.sent_at > now() - make_interval(days => wait_days)) then -- PICK: counted from the earlier request's sent_at
    raise exception 'contact request refused: asked within the last % days', wait_days using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger contact_request_check before insert on contact_request for each row execute function private.contact_request_check();
-- A notice to the other side is written by a trigger with the owner's rights, never by an app role (notification, Build 3).
-- PICK: category 'contact' and template key 'contact_request_received' are mine.
create function private.contact_request_notify() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into notification(candidate_user_id, category, template_key, params, dedupe_key)
    values (new.candidate_user_id, 'contact', 'contact_request_received', jsonb_build_object('organisation_id', new.organisation_id), md5('contact_request:' || new.id)) on conflict do nothing;
  return null;
end $$;
create trigger contact_request_notify after insert on contact_request for each row execute function private.contact_request_notify();
-- A data_request contact message gets its review_item from this trigger, because the sender cannot write review_item (contact_message).
create function private.contact_message_queue() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.topic = 'data_request' then insert into review_item(queue, contact_message_id, reason) values ('data_request', new.id, 'data request') on conflict do nothing; end if;
  return null;
end $$;
create trigger contact_message_queue after insert on contact_message for each row execute function private.contact_message_queue();
create function private.message_parent_accepted() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.contact_request_id is not null and not exists (select 1 from contact_request c where c.id = new.contact_request_id and c.status = 'accepted') then
    raise exception 'message refused: the contact request is not accepted' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger message_parent_accepted before insert on message for each row execute function private.message_parent_accepted();
create function private.message_wipe_reports() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update report set target_wiped_at = now() where target_message_id = old.id and target_wiped_at is null;
  return old;
end $$;
create trigger message_wipe_reports before delete on message for each row execute function private.message_wipe_reports();
-- candidate_user: a sign-in after the inactivity warning clears inactive_warned_at (the trigger changes the new row, so app_candidate needs no grant on it).
create function private.candidate_user_active() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.last_active_at is distinct from old.last_active_at then new.inactive_warned_at := null; end if;
  return new;
end $$;
create trigger candidate_user_active before update of last_active_at on candidate_user for each row execute function private.candidate_user_active();


-- ===== Strike deadlines and stamps, organisation columns that follow approved cases, CRO numbers, merging
-- Strike (section 6): the employer writes only employer_reply and appeal_text, and the trigger stamps the times; staff may enter a reply or appeal
-- that came by email or post with its received date; the staff ids and decision times are stamped from the acting staff id (set local app.staff_user_id).
-- Invoker's rights, because the rules depend on current_user. app_admin must have an acting id on every strike write (PICK: not only when a stamp is needed).
create function private.strike_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare staff text := nullif(current_setting('app.staff_user_id', true), ''); grace integer; ok boolean; due timestamptz;
begin
  if current_user = 'app_admin' and (staff is null or not exists (select 1 from staff_user u where u.id = staff and u.status = 'active')) then
    raise exception 'strike: no acting staff member (set local app.staff_user_id to an active staff user)' using errcode = 'P0001'; end if;
  if tg_op = 'INSERT' then
    if new.outcome is not null or new.level is not null then new.decided_by_staff_user_id := staff; new.decided_at := now(); end if;
    if current_user = 'app_admin' then
      if new.reply_due_at > now() + interval '7 days' then raise exception 'strike: reply_due_at is at most 7 days from now' using errcode = 'P0001'; end if;
      if new.appeal_due_at > coalesce(new.decided_at, now()) + interval '7 days' then raise exception 'strike: appeal_due_at is at most 7 days after the decision' using errcode = 'P0001'; end if;
    end if;
    return new;
  end if;
  if new.organisation_id is distinct from old.organisation_id then raise exception 'strike: the organisation of a case never changes' using errcode = 'P0001'; end if;
  if old.stage in ('upheld','overturned') and new.stage is distinct from old.stage then raise exception 'strike: stage never moves out of upheld or overturned' using errcode = 'P0001'; end if;
  if old.appeal_decided_at is not null and (new.outcome is distinct from old.outcome or new.level is distinct from old.level) then
    raise exception 'strike: outcome and level are frozen once the appeal is decided' using errcode = 'P0001'; end if;
  if new.outcome is distinct from old.outcome or new.level is distinct from old.level then new.decided_by_staff_user_id := staff; new.decided_at := now(); end if;
  -- deadlines: set once, within 7 days of the notice or decision; no role moves one afterwards (staff could otherwise let a late reply or appeal in)
  if current_user = 'app_admin' then
    if old.reply_due_at is not null and new.reply_due_at is distinct from old.reply_due_at then raise exception 'strike: reply_due_at never changes once set' using errcode = 'P0001'; end if;
    if old.appeal_due_at is not null and new.appeal_due_at is distinct from old.appeal_due_at then raise exception 'strike: appeal_due_at never changes once set' using errcode = 'P0001'; end if;
    if new.reply_due_at is distinct from old.reply_due_at and new.reply_due_at > now() + interval '7 days' then raise exception 'strike: reply_due_at is at most 7 days from now' using errcode = 'P0001'; end if;
    if new.appeal_due_at is distinct from old.appeal_due_at and new.appeal_due_at > coalesce(new.decided_at, now()) + interval '7 days' then raise exception 'strike: appeal_due_at is at most 7 days after the decision' using errcode = 'P0001'; end if;
  end if;
  if new.stage is distinct from old.stage and new.stage in ('upheld','overturned') then new.appeal_decided_by_staff_user_id := staff; new.appeal_decided_at := now(); end if;
  if current_user = 'app_admin' then select value into grace from setting where key = 'staff_entry_grace'; end if;
  -- reply
  if new.employer_reply is distinct from old.employer_reply then
    if old.decided_at is not null then raise exception 'strike: the case is decided, no reply' using errcode = 'P0001'; end if;
    due := old.reply_due_at;
    if current_user = 'app_portal' then ok := now() <= due; new.reply_received_at := null; new.reply_entered_by_staff_user_id := null;
    elsif current_user = 'app_admin' then
      ok := new.reply_received_at is not null and new.reply_received_at <= due and new.reply_received_at <= now() and now() <= due + make_interval(days => coalesce(grace, 0));
      new.reply_entered_by_staff_user_id := staff;
    else ok := true; end if;
    if not coalesce(ok, false) then raise exception 'strike: the reply window is closed or not open' using errcode = 'P0001'; end if;
    new.replied_at := now();
  elsif new.reply_received_at is distinct from old.reply_received_at then
    raise exception 'strike: a received date changes only in the same update as its text' using errcode = 'P0001';
  end if;
  -- appeal
  if new.appeal_text is distinct from old.appeal_text then
    if old.appeal_decided_at is not null then raise exception 'strike: the appeal is decided, no new appeal' using errcode = 'P0001'; end if;
    due := old.appeal_due_at;
    if current_user = 'app_portal' then ok := now() <= due; new.appeal_received_at := null; new.appeal_entered_by_staff_user_id := null;
    elsif current_user = 'app_admin' then
      ok := new.appeal_received_at is not null and new.appeal_received_at <= due and new.appeal_received_at <= now() and now() <= due + make_interval(days => coalesce(grace, 0));
      new.appeal_entered_by_staff_user_id := staff;
    else ok := true; end if;
    if not coalesce(ok, false) then raise exception 'strike: the appeal window is closed or not open' using errcode = 'P0001'; end if;
    new.appealed_at := now();
  elsif new.appeal_received_at is distinct from old.appeal_received_at then
    raise exception 'strike: a received date changes only in the same update as its text' using errcode = 'P0001';
  end if;
  return new;
end $function$;

create trigger strike_guard before insert or update on strike for each row execute function private.strike_guard();
-- A strike overturned on appeal clears the organisation's restriction (level 2) or claims removal (level 3).
create function private.strike_overturned()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if new.stage = 'overturned' and old.stage is distinct from 'overturned' then
    if new.level = 2 then update organisation set restricted_until = null where id = new.organisation_id and restricted_until = (select applied_at + interval '90 days' from approval_request where id = new.approval_request_id);
    elsif new.level = 3 then update organisation set claims_removed_at = null where id = new.organisation_id and claims_removed_at = (select applied_at from approval_request where id = new.approval_request_id); end if;
  end if;
  return null;
end $function$;

create trigger strike_overturned after update of stage on strike for each row execute function private.strike_overturned();

-- Organisation: status_changed_at; banned, restricted_until, claims_removed_at and verified_restricted follow approved cases (#104, #44);
-- every path back to unclaimed, and a rejected organisation, removes the memberships (and the unclaimed path empties the claim columns and closes draft and in_review jobs).
-- Owner's rights (roles that write organisation cannot read approval_request or strike).
-- PICK: restricted_until is cleared only when a level 2 case of the organisation is overturned; claims_removed_at when a level 3 case is overturned or its ban lifted (the design lists "overturned or ban lifted" for both).
-- PICK: the memberships, claim columns and draft or in_review jobs are cleaned by this trigger on every move to unclaimed or rejected, because the design says "same transaction" and names no code path.
create function private.organisation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare r approval_request; ban_stands boolean;
begin
  if tg_op = 'INSERT' then new.status_changed_at := now(); return new; end if;
  if new.status is distinct from old.status then
    new.status_changed_at := now();
    select exists (select 1 from ban b join strike s on s.id = b.strike_id where s.organisation_id = new.id) into ban_stands;
    if new.status = 'banned' and not ban_stands then raise exception 'organisation: banned only while a ban row stands for this organisation' using errcode = 'P0001'; end if;
    if old.status = 'banned' and ban_stands then raise exception 'organisation: out of banned only once no ban row stands' using errcode = 'P0001'; end if;
    if new.status = 'verified_restricted' and not coalesce(new.restricted_until > now(), false) then
      raise exception 'organisation: verified_restricted only while restricted_until is in the future' using errcode = 'P0001'; end if;
    if old.status = 'verified_restricted' and new.status = 'verified' and coalesce(new.restricted_until > now(), false) then
      raise exception 'organisation: restricted_until has not passed' using errcode = 'P0001'; end if;
    if new.status in ('unclaimed','rejected') then
      update membership set status = 'removed', removed_at = coalesce(removed_at, now()), invited_email = null, invite_token_hash = null
       where organisation_id = new.id and status <> 'removed';
    end if;
    if new.status = 'unclaimed' then
      new.claimed_at := null; new.verified_at := null; new.signup_path := null;
      update job set status = 'closed', closed_at = now(), close_reason = 'removed' where organisation_id = new.id and status in ('draft','in_review');
    end if;
  end if;
  if new.restricted_until is distinct from old.restricted_until then
    if new.restricted_until is null then
      if not exists (select 1 from strike s join approval_request a on a.id = s.approval_request_id
                     where s.organisation_id = new.id and s.level = 2 and s.stage = 'overturned' and a.applied_at + interval '90 days' = old.restricted_until) then
        raise exception 'organisation: restricted_until is cleared only when its strike 2 case is overturned' using errcode = 'P0001'; end if;
    else
      if old.restricted_until > now() then raise exception 'organisation: restricted_until never changes once set while it runs' using errcode = 'P0001'; end if;
      select a.* into r from approval_request a join strike s on s.approval_request_id = a.id
       where a.kind = 'strike_2' and a.target_table = 'strike' and a.target_id = s.id::text and s.organisation_id = new.id and s.outcome = 'strike' and s.level = 2
         and a.applied_at = now() limit 1;
      if r.id is null or new.restricted_until <> r.applied_at + interval '90 days' then
        raise exception 'organisation: restricted_until is set only in the transaction that applies a strike_2 request, to applied_at plus 90 days' using errcode = 'P0001'; end if;
      update job set badge = null where organisation_id = new.id and badge = 'sponsor_confirmed'; -- strike 2 removes the badge from all the organisation's jobs
    end if;
  end if;
  if new.claims_removed_at is distinct from old.claims_removed_at then
    if new.claims_removed_at is null then
      if not exists (select 1 from strike s join approval_request a on a.id = s.approval_request_id
                     where s.organisation_id = new.id and s.level = 3 and (s.stage = 'overturned' or s.ban_lifted_at is not null) and a.applied_at = old.claims_removed_at) then
        raise exception 'organisation: claims_removed_at is cleared only when its strike 3 case is overturned or its ban lifted' using errcode = 'P0001'; end if;
    else
      if old.claims_removed_at is not null then raise exception 'organisation: claims_removed_at never changes once set' using errcode = 'P0001'; end if;
      select a.* into r from approval_request a join strike s on s.approval_request_id = a.id
       where a.kind = 'strike_3' and a.target_table = 'strike' and a.target_id = s.id::text and s.organisation_id = new.id and s.outcome = 'strike' and s.level = 3
         and a.applied_at = now() limit 1;
      if r.id is null or new.claims_removed_at <> r.applied_at then
        raise exception 'organisation: claims_removed_at is set only in the transaction that applies a strike_3 request, to applied_at' using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end $function$;

create trigger organisation_guard before insert or update on organisation for each row execute function private.organisation_guard();
-- permit_history copied onto the organisation's jobs that are not closed when it changes (the DETE import, admin, the merge)
create function private.organisation_permit_history() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update job set permit_history = new.permit_history where organisation_id = new.id and status <> 'closed' and permit_history is distinct from new.permit_history;
  return null;
end $$;
create trigger organisation_permit_history after update of permit_history on organisation for each row execute function private.organisation_permit_history();

create function private.cro_one_organisation() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare org bigint; num text;
begin
  if tg_table_name = 'organisation' then
    if new.cro_number is null or new.status in ('rejected','closed') or new.merged_into_id is not null then return new; end if;
    org := new.id; num := new.cro_number;
  else
    if new.cro_number is null or new.organisation_id is null then return new; end if;
    if exists (select 1 from organisation o where o.id = new.organisation_id and (o.status in ('rejected','closed') or o.merged_into_id is not null)) then return new; end if;
    org := new.organisation_id; num := new.cro_number;
  end if;
  -- the organisations and names the unique index leaves out (rejected, closed or merged into another) do not hold the number
  if exists (select 1 from organisation o where o.cro_number = num and o.id <> org and o.status not in ('rejected','closed') and o.merged_into_id is null)
     or exists (select 1 from organisation_name n join organisation o on o.id = n.organisation_id
                where n.cro_number = num and n.organisation_id <> org and o.status not in ('rejected','closed') and o.merged_into_id is null) then
    raise exception 'CRO number % already belongs to another organisation', num using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger organisation_cro_one before insert or update of cro_number, status, merged_into_id on organisation for each row execute function private.cro_one_organisation();
create trigger organisation_name_cro_one before insert or update of cro_number, organisation_id on organisation_name for each row execute function private.cro_one_organisation();
create function private.organisation_merge_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.merged_into_id is not null and old.merged_into_id is null
     and exists (select 1 from membership m where m.organisation_id = new.id and m.status = 'active') then
    raise exception 'merge refused: the absorbed organisation still has active members' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger organisation_merge_check before update of merged_into_id on organisation for each row execute function private.organisation_merge_check();
-- ===== Audit
create function private.audit_pseudonymise(p_person text) returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare stand_in text := 'erased-' || gen_random_uuid()::text; n bigint;
begin
  update audit_event set
    actor_candidate_user_id = case when actor_candidate_user_id = p_person then stand_in else actor_candidate_user_id end,
    actor_portal_user_id = case when actor_portal_user_id = p_person then stand_in else actor_portal_user_id end,
    subject_candidate_user_id = case when subject_candidate_user_id = p_person then stand_in else subject_candidate_user_id end,
    object_id = case when object_id = p_person then stand_in else object_id end,
    reason_text = null, before = null, after = null
  where actor_candidate_user_id = p_person or actor_portal_user_id = p_person or subject_candidate_user_id = p_person or object_id = p_person;
  get diagnostics n = row_count; return n;
end $$;
create function private.audit_purge() returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  delete from audit_event where at < now() - interval '24 months'; -- the period is written here and changed only by migration
  get diagnostics n = row_count; return n;
end $$;


-- ===== Erasure (section 2.1). p_on_request is true for the admin app's data request and for deleted_account_grace, false for the other retention rules.
create function private.erase_candidate(p_id text, p_on_request boolean) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare keys text[] := '{}'; v_email text; k text[]; app_ids bigint[]; stand_in text := 'erased-' || gen_random_uuid()::text;
begin
  select email into v_email from candidate_user where id = p_id;
  if not found then return jsonb_build_object('erased', false, 'reason', 'not_found'); end if;
  -- 1. refuse (returned, not raised)
  if exists (select 1 from services_case where candidate_user_id = p_id and status <> 'closed') then
    return jsonb_build_object('erased', false, 'reason', 'open_services_case'); end if;
  if exists (select 1 from report where target_candidate_user_id = p_id and status in ('open','job_hidden')) then
    return jsonb_build_object('erased', false, 'reason', 'open_report'); end if;
  -- 2. applications are emptied as application_and_cv does; their messages go; the person's other messages and pending outbox rows go
  select coalesce(array_agg(id), '{}'), coalesce(array_agg(cv_storage_key) filter (where cv_storage_key is not null), '{}') into app_ids, k from application where candidate_user_id = p_id;
  keys := keys || k;
  delete from message where application_id = any(app_ids);
  update tracker_entry set application_id = null where application_id = any(app_ids);
  update application set candidate_user_id = null, consent_record_id = null, cover_note = null, answers = null, profile_summary = null, cv_storage_key = null, cv_file_name = null
   where id = any(app_ids);
  delete from message where sender_candidate_user_id = p_id;
  delete from email_outbox where candidate_user_id = p_id and status = 'pending';
  update email_outbox set candidate_user_id = stand_in, params = null where candidate_user_id = p_id and status in ('sending','sent','failed','dropped');
  -- review items that point to the person or their contact messages are closed first (step 6), so the contact_message person key can empty
  update review_item set status = 'done', outcome = 'subject_erased', decided_at = now(), candidate_user_id = null, contact_message_id = null
   where status in ('open','claimed') and (candidate_user_id = p_id or contact_message_id in (select id from contact_message where candidate_user_id = p_id));
  update contact_message set from_name = null, from_email = null,
         body = case when p_on_request then null else body end, candidate_user_id = case when p_on_request then null else candidate_user_id end
   where candidate_user_id = p_id;
  -- 3. released details
  update contact_request set released_details = null where candidate_user_id = p_id;
  -- 4. consent records become bare proof
  update consent_record set subject_erased_at = now(), job_id = null, organisation_id = null, details = null where candidate_user_id = p_id;
  -- 5. services cases (offer_details stays) and the case document copies they uploaded
  update services_case set requester_erased_at = now() where candidate_user_id = p_id;
  select coalesce(array_agg(storage_key) filter (where storage_key is not null), '{}') into k from case_document where candidate_user_id = p_id; keys := keys || k;
  update case_document set storage_key = null, file_name = null, copy_deleted_at = now() where candidate_user_id = p_id and storage_key is not null;
  -- 6. reports
  update report set reporter_wiped_at = now() where reporter_candidate_user_id = p_id;
  update report set target_wiped_at = now() where target_candidate_user_id = p_id;
  select coalesce(array_agg(storage_key), '{}') into k from candidate_cv where candidate_user_id = p_id; keys := keys || k;
  -- 7. login rows (verification rows are found by value = id or identifier = email), then the person
  delete from candidate_session where user_id = p_id;
  delete from candidate_account where user_id = p_id;
  delete from candidate_verification where value = p_id or identifier = v_email;
  insert into audit_event(kind, actor_system, action, object_type, object_id, source)
    values ('admin_action', 'erase_candidate by ' || session_user, 'candidate.erase', 'candidate_user', p_id, 'scheduled_job');
  delete from candidate_user where id = p_id;
  -- 8.
  perform private.audit_pseudonymise(p_id);
  return jsonb_build_object('erased', true, 'storage_keys', to_jsonb(keys));
end $$;
create function private.erase_portal_user(p_id text, p_on_request boolean) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text; k text[]; keys text[] := '{}'; stand_in text := 'erased-' || gen_random_uuid()::text;
begin
  select email into v_email from portal_user where id = p_id;
  if not found then return jsonb_build_object('erased', false, 'reason', 'not_found'); end if;
  if exists (select 1 from services_case where portal_user_id = p_id and status <> 'closed') then
    return jsonb_build_object('erased', false, 'reason', 'open_services_case'); end if;
  if exists (select 1 from membership m where m.portal_user_id = p_id and m.status = 'active' and m.role = 'account_owner'
             and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id)) then
    return jsonb_build_object('erased', false, 'reason', 'owner_with_members'); end if;
  update membership set status = 'removed', removed_at = coalesce(removed_at, now()), invited_email = null, invite_token_hash = null where portal_user_id = p_id;
  update consent_record set subject_erased_at = now(), job_id = null, organisation_id = null, details = null where portal_user_id = p_id;
  update services_case set requester_erased_at = now() where portal_user_id = p_id;
  select coalesce(array_agg(storage_key) filter (where storage_key is not null), '{}') into k from case_document where portal_user_id = p_id; keys := keys || k;
  update case_document set storage_key = null, file_name = null, copy_deleted_at = now() where portal_user_id = p_id and storage_key is not null;
  update report set reporter_wiped_at = now() where reporter_portal_user_id = p_id;
  update review_item set status = 'done', outcome = 'subject_erased', decided_at = now(), portal_user_id = null, contact_message_id = null
   where status in ('open','claimed') and (portal_user_id = p_id or contact_message_id in (select id from contact_message where portal_user_id = p_id));
  delete from email_outbox where portal_user_id = p_id and status = 'pending';
  update email_outbox set portal_user_id = stand_in, params = null where portal_user_id = p_id and status in ('sending','sent','failed','dropped');
  update contact_message set from_name = null, from_email = null,
         body = case when p_on_request then null else body end, portal_user_id = case when p_on_request then null else portal_user_id end
   where portal_user_id = p_id;
  delete from portal_session where user_id = p_id;
  delete from portal_account where user_id = p_id;
  delete from portal_verification where value = p_id or identifier = v_email;
  insert into audit_event(kind, actor_system, action, object_type, object_id, source)
    values ('admin_action', 'erase_portal_user by ' || session_user, 'portal_user.erase', 'portal_user', p_id, 'scheduled_job');
  delete from portal_user where id = p_id;
  perform private.audit_pseudonymise(p_id);
  return jsonb_build_object('erased', true, 'storage_keys', to_jsonb(keys));
end $$;

-- ===== Retention (section 2.1): one batch per call. The first rule, in section 7's order, whose setting is set and which still has rows due is run
-- on up to p_batch rows; the call returns that rule's key, how many rows it handled and how many are left. The admin app's route loops, one call per
-- transaction. PICK: application_and_cv is due while an application still names a candidate; inactive_profile_warning is due for a warned candidate who still has a profile or CV; `left` is an exact count of due rows after the batch. A rule's due rows apply every condition it states, and rows an open case freezes, or people an erase function refuses, are left
-- out of them and listed under `skipped`. PICK: the rules are rows of one table-driven query set (dynamic SQL), $1 = the setting value, $2 = the batch's ids as text[].
-- The rule list, one row per rule in section 7's order: key (the setting), target (which table when a rule has several), due (the due rows as one SQL query
-- returning id, $1 = the setting value), refuse (rows an open case or an erase refusal leave out), kind, act ($1 value, $2 ids; returns count and storage keys).
create function private.retention_rules() returns table(ord integer, key text, target text, due text, refuse text, kind text, act text, on_request boolean)
language sql stable set search_path = public, pg_temp as $rr$
  select * from (values
    (1,  'application_and_cv', null, $q$select a.id::text as id from application a where a.candidate_user_id is not null
          and exists (select 1 from job j where j.id = a.job_id and j.closed_at < now() - make_interval(months => $1))$q$,
         $q$exists (select 1 from services_case c where c.candidate_user_id = a.candidate_user_id and c.status <> 'closed')$q$, 'sql',
     $q$with t as (select a.id, a.cv_storage_key, a.consent_record_id from application a where a.id = any($2::bigint[]) for update),
             c as (update consent_record set job_id = null, organisation_id = null, details = null where id in (select consent_record_id from t where consent_record_id is not null)),
             tr as (update tracker_entry set application_id = null where application_id in (select id from t)),
             m as (delete from message where application_id in (select id from t)),
             u as (update application a set candidate_user_id = null, consent_record_id = null, cover_note = null, answers = null, profile_summary = null, cv_storage_key = null, cv_file_name = null
                    from t where a.id = t.id returning 1)
        select (select count(*) from u)::int, coalesce((select array_agg(cv_storage_key) filter (where cv_storage_key is not null) from t), '{}')$q$, null::boolean),
    (2,  'application_record', null, $q$select a.id::text as id from application a where a.candidate_user_id is null
          and exists (select 1 from job j where j.id = a.job_id and j.closed_at < now() - make_interval(months => $1))$q$, null, 'sql',
     $q$with d as (delete from application where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (3,  'inactive_profile', null, $q$select u.id::text as id from candidate_user u where u.deleted_at is null and u.inactive_warned_at is null
          and u.last_active_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with w as (update candidate_user set inactive_warned_at = now() where id = any($2) returning id, inactive_warned_at),
             o as (insert into email_outbox(template, candidate_user_id, dedupe_key) select 'inactive-warning', id, md5('inactive-warning:' || id || ':' || inactive_warned_at::date) from w
                    on conflict (dedupe_key) do nothing)
        select count(*)::int, '{}'::text[] from w$q$, null),
    (4,  'inactive_profile_warning', null, $q$select u.id::text as id from candidate_user u where u.inactive_warned_at < now() - make_interval(days => $1)
          and (exists (select 1 from candidate_profile p where p.candidate_user_id = u.id) or exists (select 1 from candidate_cv c where c.candidate_user_id = u.id))$q$, null, 'sql',
     $q$with cv as (delete from candidate_cv where candidate_user_id = any($2) returning storage_key),
             pr as (delete from candidate_profile where candidate_user_id = any($2) returning 1)
        select cardinality($2)::int, coalesce((select array_agg(storage_key) from cv), '{}')$q$, null),
    (5,  'inactive_account', null, $q$select u.id::text as id from candidate_user u where u.deleted_at is null and u.last_active_at < now() - make_interval(months => $1)$q$,
         $q$exists (select 1 from services_case c where c.candidate_user_id = u.id and c.status <> 'closed') or exists (select 1 from report r where r.target_candidate_user_id = u.id and r.status in ('open','job_hidden'))$q$,
     'erase_candidate', null, false),
    (6,  'unverified_account', 'candidate', $q$select u.id::text as id from candidate_user u where u.email_verified = false and u.created_at < now() - make_interval(days => $1)$q$,
         $q$exists (select 1 from services_case c where c.candidate_user_id = u.id and c.status <> 'closed') or exists (select 1 from report r where r.target_candidate_user_id = u.id and r.status in ('open','job_hidden'))$q$,
     'erase_candidate', null, false),
    (7,  'unverified_account', 'portal', $q$select u.id::text as id from portal_user u where u.email_verified = false and u.created_at < now() - make_interval(days => $1)$q$,
         $q$exists (select 1 from services_case c where c.portal_user_id = u.id and c.status <> 'closed') or exists (select 1 from membership m where m.portal_user_id = u.id and m.status = 'active' and m.role = 'account_owner' and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id))$q$,
     'erase_portal_user', null, false),
    (8,  'deleted_account_grace', 'candidate', $q$select u.id::text as id from candidate_user u where u.deleted_at < now() - make_interval(days => $1)$q$,
         $q$exists (select 1 from services_case c where c.candidate_user_id = u.id and c.status <> 'closed') or exists (select 1 from report r where r.target_candidate_user_id = u.id and r.status in ('open','job_hidden'))$q$,
     'erase_candidate', null, true),
    (9,  'deleted_account_grace', 'portal', $q$select u.id::text as id from portal_user u where u.deleted_at < now() - make_interval(days => $1)$q$,
         $q$exists (select 1 from services_case c where c.portal_user_id = u.id and c.status <> 'closed') or exists (select 1 from membership m where m.portal_user_id = u.id and m.status = 'active' and m.role = 'account_owner' and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id))$q$,
     'erase_portal_user', null, true),
    (10, 'apply_click', null, $q$select id::text as id from apply_click where clicked_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from apply_click where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (11, 'contact_request_record', null, $q$select id::text as id from contact_request where status <> 'sent' and coalesce(answered_at, sent_at) < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from contact_request where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (12, 'contact_request_expiry', null, $q$select id::text as id from contact_request where status = 'sent' and sent_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (update contact_request set status = 'expired', answered_at = now() where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (13, 'claim_needs_info', null, $q$select id::text as id from organisation where status = 'needs_info' and status_changed_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (update organisation set status = 'unclaimed' where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (14, 'portal_removed_member', null, $q$select u.id::text as id from portal_user u where (
          (exists (select 1 from membership m where m.portal_user_id = u.id)
             and not exists (select 1 from membership m where m.portal_user_id = u.id and (m.status <> 'removed' or m.removed_at > now() - make_interval(months => $1))))
          or (u.email_verified and not exists (select 1 from membership m where m.portal_user_id = u.id) and u.created_at < now() - make_interval(months => $1)))$q$,
         $q$exists (select 1 from services_case c where c.portal_user_id = u.id and c.status <> 'closed') or exists (select 1 from membership m where m.portal_user_id = u.id and m.status = 'active' and m.role = 'account_owner' and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id))$q$,
     'erase_portal_user', null, false),
    (15, 'draft_job', null, $q$select id::text as id from job where status = 'draft' and created_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with t as (delete from job_text where job_id = any($2::bigint[]) returning 1),
             d as (update job set status = 'closed', closed_at = now(), close_reason = 'abandoned', search_vector = null where id = any($2::bigint[]) returning 1)
        select count(*)::int, '{}'::text[] from d$q$, null),
    (16, 'portal_signer_name', 'statement', $q$select s.id::text as id from sponsorship_statement s join job j on j.id = s.job_id where j.closed_at < now() - make_interval(months => $1)
          and s.signer_name is not null and s.signer_name <> 'member of ' || (select display_name from organisation where id = s.organisation_id)
          and not exists (select 1 from strike k where k.job_id = s.job_id)$q$, null, 'sql',
     $q$with d as (update sponsorship_statement st set signer_name = 'member of ' || o.display_name, signer_title = null from organisation o where st.id = any($2::bigint[]) and o.id = st.organisation_id returning 1)
        select count(*)::int, '{}'::text[] from d$q$, null),
    (17, 'portal_signer_name', 'floor', $q$select f.id::text as id from pay_floor f where f.ended_at < now() - make_interval(months => $1) and f.signer_name is not null
          and f.signer_name not like 'member of %' and not exists (select 1 from strike k where k.pay_floor_id = f.id)$q$, null, 'sql',
     $q$with d as (update pay_floor f set signer_name = 'member of ' || o.display_name, signer_title = null from organisation o where f.id = any($2::bigint[]) and o.id = f.organisation_id returning 1)
        select count(*)::int, '{}'::text[] from d$q$, null),
    (18, 'services_case_copy', null, $q$select d.id::text as id from case_document d join services_case c on c.id = d.services_case_id
          where c.status = 'closed' and c.closed_at < now() - make_interval(days => $1) and d.storage_key is not null$q$, null, 'sql',
     $q$with t as (select id, storage_key from case_document where id = any($2::bigint[]) for update),
             u as (update case_document d set storage_key = null, file_name = null, copy_deleted_at = now() from t where d.id = t.id returning 1)
        select (select count(*) from u)::int, coalesce((select array_agg(storage_key) from t), '{}')$q$, null),
    (19, 'services_case_record', null, $q$select c.id::text as id from services_case c where c.status = 'closed' and c.closed_at < now() - make_interval(months => $1)
          and not exists (select 1 from case_quote q where q.services_case_id = c.id)$q$, null, 'sql',
     $q$with d as (delete from services_case where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (20, 'case_invoice_record', null, $q$select q.id::text as id from case_quote q join services_case c on c.id = q.services_case_id
          where c.status = 'closed' and c.closed_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from case_quote where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (21, 'strike_and_report_evidence', 'strike', $q$select s.id::text as id from strike s where s.stage in ('decided','applied','upheld','overturned')
          and greatest(s.decided_at, s.appeal_decided_at) < now() - make_interval(months => $1)
          and not exists (select 1 from strike b where b.organisation_id = s.organisation_id
               and (b.id = s.id or (b.level = 3 and s.outcome = 'strike' and s.level < 3 and s.stage <> 'overturned' and s.decided_at < b.decided_at))
               and (b.ban_lifted_at is not null or exists (select 1 from ban where ban.strike_id = b.id)))$q$, null, 'sql',
     $q$with d as (delete from strike where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (22, 'strike_and_report_evidence', 'report', $q$select p.id::text as id from report p where p.status in ('cleared','upheld') and p.decided_at < now() - make_interval(months => $1)
          and not exists (select 1 from strike k where k.report_id = p.id) and not exists (select 1 from job j where j.hidden_report_id = p.id)$q$, null, 'sql',
     $q$with d as (delete from report where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (23, 'ban_evidence', null, $q$select s.id::text as id from strike s where s.stage in ('decided','applied','upheld','overturned')
          and exists (select 1 from strike b where b.organisation_id = s.organisation_id
               and (b.id = s.id or (b.level = 3 and s.outcome = 'strike' and s.level < 3 and s.stage <> 'overturned' and s.decided_at < b.decided_at))
               and (b.ban_lifted_at is not null or exists (select 1 from ban where ban.strike_id = b.id)))
          and not exists (select 1 from strike b where b.organisation_id = s.organisation_id
               and (b.id = s.id or (b.level = 3 and s.outcome = 'strike' and s.level < 3 and s.stage <> 'overturned' and s.decided_at < b.decided_at))
               and (b.ban_lifted_at is not null or exists (select 1 from ban where ban.strike_id = b.id))
               and (exists (select 1 from ban where ban.strike_id = b.id) or b.ban_lifted_at >= now() - make_interval(months => $1)))$q$, null, 'sql',
     $q$with d as (delete from strike where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (24, 'consent_bare_proof', null, $q$select r.id::text as id from consent_record r where r.subject_erased_at < now() - make_interval(months => $1)
          and not exists (select 1 from application x where x.consent_record_id = r.id) and not exists (select 1 from contact_request x where x.consent_record_id = r.id)
          and not exists (select 1 from services_case x where x.consent_record_id = r.id or x.employer_contact_consent_record_id = r.id)$q$, null, 'sql',
     $q$with d as (delete from consent_record where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (25, 'contact_message', null, $q$select c.id::text as id from contact_message c where c.status in ('answered','closed','spam')
          and coalesce(c.closed_at, c.created_at) < now() - make_interval(months => $1)
          and not exists (select 1 from review_item i where i.contact_message_id = c.id and i.status in ('open','claimed'))$q$, null, 'sql',
     $q$with d as (delete from contact_message where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (26, 'review_item_done', null, $q$select id::text as id from review_item where status in ('done','dropped') and coalesce(decided_at, created_at) < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from review_item where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (27, 'notification_read', null, $q$select id::text as id from notification where read_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from notification where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (28, 'notification_unread', null, $q$select id::text as id from notification where read_at is null and created_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from notification where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (29, 'email_outbox_sent', null, $q$select id::text as id from email_outbox where status in ('sending','sent','failed','dropped') and params is not null
          and coalesce(sent_at, send_after) < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (update email_outbox set params = null where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (30, 'email_outbox_record', null, $q$select id::text as id from email_outbox where status in ('sending','sent','failed','dropped')
          and coalesce(sent_at, send_after) < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from email_outbox where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (31, 'rejected_advert', null, $q$select f.id::text as id from fetched_advert f where f.result = 'rejected' and f.last_seen_at < now() - make_interval(months => $1)
          and not exists (select 1 from job j where j.fetched_advert_id = f.id)$q$, null, 'sql',
     $q$with d as (delete from fetched_advert where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (32, 'closed_job_unreferenced', null, $q$select j.id::text as id from job j where j.status = 'closed' and j.closed_at < now() - make_interval(months => $1)
          and not exists (select 1 from saved_job x where x.job_id = j.id) and not exists (select 1 from tracker_entry x where x.job_id = j.id)
          and not exists (select 1 from apply_click x where x.job_id = j.id) and not exists (select 1 from application x where x.job_id = j.id)
          and not exists (select 1 from services_case x where x.job_id = j.id) and not exists (select 1 from report x where x.target_job_id = j.id)
          and not exists (select 1 from strike x where x.job_id = j.id)
          and not exists (select 1 from review_item x where x.job_id = j.id and x.status in ('open','claimed'))$q$, null, 'sql',
     $q$with s as (delete from sponsorship_statement where job_id = any($2::bigint[]) returning 1),
             j as (select id, fetched_advert_id from job where id = any($2::bigint[])),
             d as (delete from job where id in (select id from j) returning 1),
             f as (delete from fetched_advert where id in (select fetched_advert_id from j where fetched_advert_id is not null) returning 1)
        select (select count(*) from d)::int, '{}'::text[]$q$, null),
    (33, 'fetch_run', null, $q$select id::text as id from fetch_run where started_at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from fetch_run where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (34, 'expired_login_rows', 'candidate_session', $q$select id::text as id from candidate_session where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from candidate_session where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (35, 'expired_login_rows', 'portal_session', $q$select id::text as id from portal_session where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from portal_session where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (36, 'expired_login_rows', 'staff_session', $q$select id::text as id from staff_session where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from staff_session where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (37, 'expired_login_rows', 'candidate_verification', $q$select id::text as id from candidate_verification where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from candidate_verification where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (38, 'expired_login_rows', 'portal_verification', $q$select id::text as id from portal_verification where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from portal_verification where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (39, 'expired_login_rows', 'staff_verification', $q$select id::text as id from staff_verification where expires_at < now() - make_interval(days => $1)$q$, null, 'sql',
     $q$with d as (delete from staff_verification where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    -- a rate-limit row has no expiry, so it counts from its last request (last_request is epoch milliseconds)
    (40, 'expired_login_rows', 'candidate_rate_limit', $q$select id::text as id from candidate_rate_limit where last_request < (extract(epoch from now() - make_interval(days => $1)) * 1000)::bigint$q$, null, 'sql',
     $q$with d as (delete from candidate_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (41, 'expired_login_rows', 'portal_rate_limit', $q$select id::text as id from portal_rate_limit where last_request < (extract(epoch from now() - make_interval(days => $1)) * 1000)::bigint$q$, null, 'sql',
     $q$with d as (delete from portal_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null),
    (42, 'expired_login_rows', 'staff_rate_limit', $q$select id::text as id from staff_rate_limit where last_request < (extract(epoch from now() - make_interval(days => $1)) * 1000)::bigint$q$, null, 'sql',
     $q$with d as (delete from staff_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null)
  ) as t(ord, key, target, due, refuse, kind, act, on_request) order by ord
$rr$;
create function private.approval_request_due() returns setof bigint language sql stable security definer set search_path = public, pg_temp as $$
  select a2.id from approval_request a2 where a2.created_at < now() - interval '24 months' and a2.status <> 'pending'
      and not exists (select 1 from staff_role x where x.approval_request_id = a2.id) and not exists (select 1 from ban x where x.approval_request_id = a2.id)
      and not exists (select 1 from strike x where x.approval_request_id = a2.id) and not exists (select 1 from pay_floor x where x.approval_request_id = a2.id)
      and not exists (select 1 from sponsorship_statement x where x.approval_request_id = a2.id) and not exists (select 1 from consent_text x where x.approval_request_id = a2.id)
$$;
create function private.run_retention(p_batch integer default 1000) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare rule record; due_sql text; v integer; ids text[]; n integer := 0; keys text[] := '{}'; k text[]; left_n bigint; skipped jsonb := '[]'; res jsonb; i text; out jsonb;
  fn text := 'run_retention by ' || session_user;
begin
  for rule in select * from private.retention_rules()
  loop
    select value into v from setting where key = rule.key;
    if v is null then continue; end if;
    due_sql := rule.due;
    -- rows an open case freezes, or an erase function would refuse, are left out of the due rows and listed
    if rule.refuse is not null then
      for i in execute 'select id from (' || due_sql || ' and (' || rule.refuse || ') limit 50) x' using v loop
        skipped := skipped || jsonb_build_object('rule', rule.key, 'target', rule.target, 'id', i, 'reason', 'frozen_or_refused'); end loop;
      due_sql := due_sql || ' and not (' || rule.refuse || ')';
    end if;
    execute 'select coalesce(array_agg(id), ''{}'') from (' || due_sql || ' limit ' || p_batch || ') x' into ids using v;
    if cardinality(ids) = 0 then continue; end if;
    if rule.kind = 'sql' then
      execute rule.act into n, keys using v, ids;
    else
      n := 0;
      foreach i in array ids loop
        if rule.kind = 'erase_candidate' then res := private.erase_candidate(i, rule.on_request); else res := private.erase_portal_user(i, rule.on_request); end if;
        if (res->>'erased')::boolean then n := n + 1; keys := keys || array(select jsonb_array_elements_text(res->'storage_keys'));
        else skipped := skipped || jsonb_build_object('rule', rule.key, 'target', rule.target, 'id', i, 'reason', res->>'reason'); end if;
      end loop;
    end if;
    execute 'select count(*) from (' || due_sql || ') x' into left_n using v;
    out := jsonb_build_object('rule', rule.key, 'target', rule.target, 'done', n, 'left', left_n, 'skipped', skipped, 'storage_keys', to_jsonb(keys));
    insert into audit_event(kind, actor_system, action, after, source) values ('admin_action', fn, 'retention.run', out - 'storage_keys' - 'skipped', 'scheduled_job');
    return out;
  end loop;
  -- approval requests after the audit period, only when nothing points to them (24 months, as in audit_purge); not a setting
  -- C3 FIX 1: the due rows come from one function, so `left` counts only rows the delete can reach
  delete from approval_request a where a.id in (select private.approval_request_due() limit p_batch);
  get diagnostics n = row_count;
  if n > 0 then return jsonb_build_object('rule', 'approval_request', 'done', n, 'left', (select count(*) from private.approval_request_due()), 'skipped', skipped, 'storage_keys', '[]'::jsonb); end if;
  return jsonb_build_object('rule', null, 'done', 0, 'left', 0, 'skipped', skipped, 'storage_keys', '[]'::jsonb);
end $$;


-- ===== Sign-up functions (portal paths 1, 2 and 3)
create function private.claim_organisation(p_portal_user_id text, p_organisation_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_status text; v_mem bigint;
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'claim refused: unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'claim refused: email not verified' using errcode = 'P0001'; end if;
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'claim refused: email domain is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban b where b.cro_number in (select o.cro_number from organisation o where o.id = p_organisation_id
             union select n.cro_number from organisation_name n where n.organisation_id = p_organisation_id)) then
    raise exception 'claim refused: company number is banned' using errcode = 'P0001'; end if;
  v_status := case when exists (select 1 from organisation_domain d where d.organisation_id = p_organisation_id and d.domain = v_domain)
                    and not exists (select 1 from organisation_domain d where d.domain = v_domain and d.organisation_id <> p_organisation_id)
               then 'verified' else 'pending_review' end;
  update organisation set status = v_status, claimed_at = now(), signup_path = 'dete_claim', verified_at = case when v_status = 'verified' then now() end
   where id = p_organisation_id and status = 'unclaimed';
  if not found then raise exception 'claim refused: organisation is not unclaimed' using errcode = 'P0001'; end if;
  insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values (p_organisation_id, p_portal_user_id, 'account_owner', 'active', true, now()) returning id into v_mem;
  if v_status = 'pending_review' then insert into review_item(queue, organisation_id, reason) values ('account_review', p_organisation_id, 'claim') on conflict do nothing; end if;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, after, source)
    values ('security', p_portal_user_id, 'organisation.claim', 'organisation', p_organisation_id::text, jsonb_build_object('status', v_status), 'site');
  return jsonb_build_object('organisation_id', p_organisation_id, 'status', v_status, 'membership_id', v_mem);
end $$;
create function private.register_organisation(p_portal_user_id text, p_kind text, p_display_name text, p_cro_number text, p_wrc_licence_number text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_org bigint; v_mem bigint; found_in_register boolean; reg_name text; v_slug text; v_base text; v_try integer := 1;
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'sign-up refused: unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'sign-up refused: email not verified' using errcode = 'P0001'; end if;
  if p_kind not in ('employer','agency') then raise exception 'sign-up refused: kind must be employer or agency' using errcode = 'P0001'; end if;
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'sign-up refused: email domain is banned' using errcode = 'P0001'; end if;
  if p_cro_number is not null and exists (select 1 from ban where cro_number = p_cro_number) then raise exception 'sign-up refused: company number is banned' using errcode = 'P0001'; end if;
  if p_kind = 'employer' then select true, name into found_in_register, reg_name from cro_company where cro_number = p_cro_number;
  else select true, agency_name into found_in_register, reg_name from wrc_licence where licence_number = p_wrc_licence_number; end if;
  -- slug: the lower-case words of display_name joined by hyphens, with -2, -3 added on a clash (organisation)
  v_base := btrim(lower(regexp_replace(p_display_name, '[^a-zA-Z0-9]+', '-', 'g')), '-'); v_slug := v_base;
  while exists (select 1 from organisation where slug = v_slug) loop v_try := v_try + 1; v_slug := v_base || '-' || v_try; end loop;
  insert into organisation(slug, display_name, kind, status, signup_path, cro_number, wrc_licence_number, claimed_at)
    values (v_slug,
            p_display_name, p_kind, 'pending_review', case when p_kind = 'employer' then 'first_time' else 'agency' end,
            case when p_kind = 'employer' then p_cro_number end, case when p_kind = 'agency' then p_wrc_licence_number end, now()) returning id into v_org;
  insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values (v_org, p_portal_user_id, 'account_owner', 'active', true, now()) returning id into v_mem;
  insert into review_item(queue, organisation_id, reason, detail) values ('account_review', v_org, 'new organisation',
    jsonb_build_object('register', case when p_kind = 'employer' then 'cro_company' else 'wrc_licence' end, 'found', coalesce(found_in_register, false),
                       'name_matches', reg_name is not null and lower(reg_name) = lower(p_display_name)));
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source)
    values ('security', p_portal_user_id, 'organisation.register', 'organisation', v_org::text, 'site');
  return jsonb_build_object('organisation_id', v_org, 'status', 'pending_review', 'membership_id', v_mem, 'found_in_register', coalesce(found_in_register, false));
end $$;

-- ===== Launch B functions (no grants until the Launch B migration)
create function private.move_application(p_application_id bigint, p_status text, p_membership_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('viewed','shortlisted','rejected','offer','hired') then raise exception 'move refused: status % is not an employer move', p_status using errcode = 'P0001'; end if;
  if not exists (select 1 from application a join membership m on m.organisation_id = a.organisation_id
                 where a.id = p_application_id and m.id = p_membership_id and m.status = 'active' and m.role in ('recruiter','account_owner')) then
    raise exception 'move refused: not an active recruiter of this organisation' using errcode = 'P0001'; end if;
  update application set status = p_status where id = p_application_id and status <> 'withdrawn';
  if not found then raise exception 'move refused: application withdrawn or missing' using errcode = 'P0001'; end if;
  -- the notice to the candidate is written here with the owner's rights (notification, Build 3). PICK: category 'application', template key 'application_moved'.
  insert into notification(candidate_user_id, category, template_key, params, dedupe_key)
    select a.candidate_user_id, 'application', 'application_moved', jsonb_build_object('status', p_status, 'application_id', a.id), md5('application_moved:' || a.id || ':' || p_status)
      from application a where a.id = p_application_id and a.candidate_user_id is not null on conflict do nothing;
  update tracker_entry set stage = p_status, updated_at = now() where application_id = p_application_id and route = 'on_site';
end $$;
create function private.search_visible_candidates(p_organisation_id bigint, p_filters jsonb, p_cursor bigint) returns table(profile_id bigint, candidate_user_id text, fields jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select p.id, p.candidate_user_id,
         (select jsonb_object_agg(f, x.v) from jsonb_each(to_jsonb(p) - 'full_name' - 'phone' - 'registration_number') x(f, v) where f = any(p.visible_fields))
  from candidate_profile p join candidate_user u on u.id = p.candidate_user_id
  where p.visible_to_employers and u.suspended_at is null and u.deleted_at is null
    and (p_filters->>'occupation_code' is null or p.occupation_code = p_filters->>'occupation_code')
    and not exists (select 1 from candidate_hidden_organisation h where h.candidate_user_id = p.candidate_user_id and h.organisation_id = p_organisation_id)
    and (p_cursor is null or p.id < p_cursor)
  order by p.id desc limit 21
$$;

-- ===== Proven fixes folded in last (they add objects; the replaced functions are above in their final form)
-- FIX 2 (a job set to closed without closed_at is never reached by application_and_cv, application_record, portal_signer_name or closed_job_unreferenced)
create function private.job_closed_at() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin if new.status = 'closed' and new.closed_at is null then new.closed_at := now(); end if; return new; end $$;
create trigger job_closed_at before insert or update of status on job for each row execute function private.job_closed_at();

-- FIX-1: a ban row names only the case organisation's own CRO number and its own domains (the confirmation covers the case, not what the applying officer types)
create function private.ban_matches_case() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation;
begin
  select o2.* into o from strike s join organisation o2 on o2.id = s.organisation_id where s.id = new.strike_id;
  if new.cro_number is not null and new.cro_number is distinct from o.cro_number then
    raise exception 'ban refused: cro_number is not the case organisation''s' using errcode = 'P0001'; end if;
  if new.email_domain is not null and not exists (select 1 from organisation_domain d where d.organisation_id = o.id and d.domain = new.email_domain) then
    raise exception 'ban refused: email_domain is not one of the case organisation''s domains' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger ban_matches_case before insert on ban for each row execute function private.ban_matches_case();

-- FIX-5 (optional, a PICK for the owner): app_admin disables staff but cannot turn a disabled login back on; only the owner (a migration or break-glass) can.
-- Without it one administrator can re-enable a leaver who still holds a role and act as them (the acting id accepts any active staff_user).
create function private.staff_user_no_reactivation() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'disabled' and new.status is distinct from old.status and current_user = 'app_admin' then
    raise exception 'staff_user: a disabled login is not turned back on by app_admin' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger staff_user_no_reactivation before update of status on staff_user for each row execute function private.staff_user_no_reactivation();

reset role;
