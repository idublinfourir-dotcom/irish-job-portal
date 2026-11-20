-- Permit services schema (step 15 SV-0, decisions #256 and #272, answers S-Q1, S-Q3, S-Q4, S-Q9, S-Q10, S-Q11 in services-plan-check.md).
--   1. services_case.decision_outcome (S-Q3 A): null, granted or refused; set only at status decision or closed, and a closed case with an outcome
--      was closed as decided.
--   2. services_case.documents_needed (S-Q4 A): the codes staff ticked; the labels live in code. The database checks the shape only
--      (private.case_codes_ok: at most 30 codes, each ^[a-z][a-z0-9_]{0,39}$, no duplicates, no nulls).
--   3. referral_solicitor (S-Q10 B): the staff-managed list of firms a case may be referred to; services_case.referral_solicitor_id only on a case
--      closed as referred_to_solicitor. app_admin selects, inserts and updates; no app role deletes; candidate and portal nothing.
--   4. case_event (S-Q9): the ticket-style timeline. detail holds codes and ids only (private.case_event_detail_ok names the keys). app_admin
--      selects and inserts; the requester roles insert only received or withdrawn on a case they can read (case_event_guard) and read only
--      through private.candidate_case_timeline or private.portal_case_timeline. A requester event names its writer (candidate_user_id or portal_user_id, as case_document does). No update or delete for any app role. An app role cannot set `at`: it is always now().
--   5. private.case_readable_by (S-Q1 B): the one reader rule for every requester read of this wave, internal; each app reaches it only through
--      its own side's wrapper (private.candidate_case_readable for app_candidate, private.portal_case_readable for app_portal). The company branch covers portal cases
--      only: a candidate's case that names a company is never the company's to read (20d:109).
--   6. private.case_timeline (internal; wrappers private.candidate_case_timeline and private.portal_case_timeline): the requester's view of the events; never staff_user_id, never a note; empty when not readable.
--   7. private.merge_organisations (last defined in 0056, copied exactly; lines marked 0061 added): the absorbed company's services cases,
--      open or closed, move to the survivor, ids in the audit row (case_ids).
set role portal_owner;

-- ===== 2. code lists
create function private.case_codes_ok(a text[]) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select a is not null and coalesce(array_ndims(a), 1) = 1 and cardinality(a) <= 30 and array_position(a, null) is null
     and (select coalesce(bool_and(c ~ '^[a-z][a-z0-9_]{0,39}$'), true) and count(distinct c) = count(*) from unnest(a) c)
$$;

-- ===== 3. referral solicitors
create table referral_solicitor(
  id bigint generated always as identity primary key,
  firm text not null check (firm = btrim(firm) and length(firm) between 1 and 200 and firm !~ '[[:cntrl:]]'),
  contact text not null check (contact = btrim(contact) and length(contact) between 1 and 300 and contact !~ '[[:cntrl:]]'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by_staff_user_id text not null references staff_user(id));
create index referral_solicitor_staff_idx on referral_solicitor(created_by_staff_user_id);
grant select, insert, update on referral_solicitor to app_admin;

-- ===== 1, 2, 3. services_case columns
alter table services_case
  add column decision_outcome text check (decision_outcome in ('granted','refused')),
  add column documents_needed text[] not null default '{}' check (private.case_codes_ok(documents_needed)),
  add column referral_solicitor_id bigint references referral_solicitor(id),
  add constraint services_case_outcome_status check (decision_outcome is null or status in ('decision','closed')),
  add constraint services_case_outcome_closed check (decision_outcome is null or status <> 'closed' or close_reason = 'decided'),
  add constraint services_case_referral_reason check (referral_solicitor_id is null or close_reason is not distinct from 'referred_to_solicitor');
create index services_case_referral_idx on services_case(referral_solicitor_id);

-- ===== 4. the timeline
-- Keys of detail (all optional): documentsNeeded (array of codes), outcome (granted or refused), referralSolicitorId (a positive integer),
-- assignedStaffUserId (a staff id, internal). Nothing else, so no staff free text can land here.
create function private.case_event_detail_ok(d jsonb) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select jsonb_typeof(d) = 'object' and length(d::text) <= 2048
     and d - array['documentsNeeded','outcome','referralSolicitorId','assignedStaffUserId'] = '{}'::jsonb
     and (not d ? 'documentsNeeded' or (jsonb_typeof(d->'documentsNeeded') = 'array'
          and not jsonb_path_exists(d->'documentsNeeded', '$[*] ? (@.type() != "string")')
          and private.case_codes_ok(array(select jsonb_array_elements_text(d->'documentsNeeded')))))
     and (not d ? 'outcome' or d->'outcome' in ('"granted"'::jsonb, '"refused"'::jsonb))
     and (not d ? 'referralSolicitorId' or (jsonb_typeof(d->'referralSolicitorId') = 'number' and (d->>'referralSolicitorId') ~ '^[1-9][0-9]{0,17}$'))
     and (not d ? 'assignedStaffUserId' or (jsonb_typeof(d->'assignedStaffUserId') = 'string' and (d->>'assignedStaffUserId') ~ '^[A-Za-z0-9_-]{1,64}$'))
$$;

create table case_event(
  id bigint generated always as identity primary key,
  case_id bigint not null references services_case(id) on delete cascade,
  at timestamptz not null default now(),
  kind text not null check (kind in ('received','assigned','status_changed','documents_needed','decision','closed','referred','withdrawn')),
  status text not null check (status in ('received','documents_needed','waiting_for_employer','submitted','decision','closed')),
  detail jsonb not null default '{}' check (private.case_event_detail_ok(detail)),
  staff_user_id text references staff_user(id),
  -- who wrote a requester event (the 0005 guard pattern: the guard checks this login can read the case); never in a timeline read
  candidate_user_id text references candidate_user(id) on delete set null, portal_user_id text references portal_user(id) on delete set null,
  check (num_nonnulls(staff_user_id, candidate_user_id, portal_user_id) <= 1));
-- The two shape checks are pure; every role that writes services_case or case_event runs them inside the checks.
grant execute on function private.case_codes_ok(text[]), private.case_event_detail_ok(jsonb) to app_admin, app_candidate, app_portal;
create index case_event_case_idx on case_event(case_id, at, id);
create index case_event_staff_idx on case_event(staff_user_id);
create index case_event_candidate_idx on case_event(candidate_user_id);
create index case_event_portal_idx on case_event(portal_user_id);

-- ===== 5. the reader rule
create function private.case_readable_by(p_side text, p_user text, p_case bigint) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select case p_side
      when 'candidate' then s.candidate_user_id = p_user
      when 'portal' then s.portal_user_id = p_user or (s.portal_user_id is not null and exists (select 1 from membership m where m.portal_user_id = p_user
        and m.organisation_id = s.organisation_id and m.status = 'active' and m.role in ('account_owner','recruiter')))
    end from services_case s where s.id = p_case), false)
$$;
-- Each side gets its own wrapper, executable by its own login only, so the candidate app cannot read a portal case (and back); the side-taking
-- functions stay internal (no app role executes them).
create function private.candidate_case_readable(p_user text, p_case bigint) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.case_readable_by('candidate', p_user, p_case) $$;
create function private.portal_case_readable(p_user text, p_case bigint) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$ select private.case_readable_by('portal', p_user, p_case) $$;
grant execute on function private.candidate_case_readable(text, bigint) to app_candidate;
grant execute on function private.portal_case_readable(text, bigint) to app_portal;

-- The requester side writes received and withdrawn only, on a case it can read, with no detail and no staff id; `at` is always now().
-- Invoker's rights, so current_user is the app role, which then reaches only its own side's wrapper.
create function private.case_event_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
declare ok boolean;
begin
  if current_user like 'app\_%' then new.at := now(); end if;
  if current_user in ('app_candidate','app_portal') then
    if new.kind not in ('received','withdrawn') then
      raise exception 'case event guard: the requester writes only received or withdrawn' using errcode = 'P0001'; end if;
    if new.status <> (case new.kind when 'received' then 'received' else 'closed' end) or new.detail <> '{}'::jsonb or new.staff_user_id is not null then
      raise exception 'case event guard: received is at status received, withdrawn at closed, with no detail' using errcode = 'P0001'; end if;
    -- two statements, not one CASE: Postgres checks execute rights on every function of an expression, taken branch or not
    if current_user = 'app_candidate' then
      ok := new.portal_user_id is null and private.candidate_case_readable(new.candidate_user_id, new.case_id);
    else
      ok := new.candidate_user_id is null and private.portal_case_readable(new.portal_user_id, new.case_id);
    end if;
    if not coalesce(ok, false) then raise exception 'case event guard: not a case of this login' using errcode = 'P0001'; end if;
  end if;
  return new;
end $$;
create trigger case_event_guard before insert on case_event for each row execute function private.case_event_guard();

grant select, insert on case_event to app_admin;
grant insert (case_id, kind, status, candidate_user_id) on case_event to app_candidate;
grant insert (case_id, kind, status, portal_user_id) on case_event to app_portal;

-- ===== 6. the requester's timeline
create function private.case_timeline(p_side text, p_user text, p_case bigint) returns table(at timestamptz, kind text, status text, detail jsonb)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.at, e.kind, e.status,
         jsonb_strip_nulls(jsonb_build_object('documentsNeeded', e.detail->'documentsNeeded', 'outcome', e.detail->'outcome', 'referralSolicitorId', e.detail->'referralSolicitorId'))
    from case_event e where e.case_id = p_case and private.case_readable_by(p_side, p_user, p_case)
   order by e.at, e.id
$$;
create function private.candidate_case_timeline(p_user text, p_case bigint) returns table(at timestamptz, kind text, status text, detail jsonb)
language sql stable security definer set search_path = public, pg_temp as $$ select * from private.case_timeline('candidate', p_user, p_case) $$;
create function private.portal_case_timeline(p_user text, p_case bigint) returns table(at timestamptz, kind text, status text, detail jsonb)
language sql stable security definer set search_path = public, pg_temp as $$ select * from private.case_timeline('portal', p_user, p_case) $$;
grant execute on function private.candidate_case_timeline(text, bigint) to app_candidate;
grant execute on function private.portal_case_timeline(text, bigint) to app_portal;

-- ===== 7. merges (0056 text, lines marked 0061 added)
create or replace function private.merge_organisations(p_staff text, p_absorbed bigint, p_survivor bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a organisation; s organisation; v_names bigint[]; v_jobs bigint[]; v_posted jsonb; v_hist_before text; v_hist text; v_reports bigint[]; v_strikes bigint[];
  v_cases bigint[]; -- 0061
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer','fetched_job_reviewer'], 'NOT_COMPANY_STAFF');
  if p_absorbed is null or p_survivor is null then raise exception 'merge refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if p_absorbed = p_survivor then raise exception 'merge refused: SAME_COMPANY a company cannot be merged into itself' using errcode = 'P0001'; end if;
  perform 1 from organisation where id in (p_absorbed, p_survivor) order by id for update; -- both rows, lowest id first: two merges cannot deadlock
  select * into a from organisation where id = p_absorbed;
  select * into s from organisation where id = p_survivor;
  if a.id is null or s.id is null then raise exception 'merge refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if a.merged_into_id is not null then raise exception 'merge refused: ALREADY_MERGED the absorbed company was merged already' using errcode = 'P0001'; end if;
  if s.merged_into_id is not null then raise exception 'merge refused: TARGET_MERGED the surviving company was merged into another company' using errcode = 'P0001'; end if;
  if a.status in ('rejected','closed','banned','suspended') or s.status in ('rejected','closed','banned','suspended') then
    raise exception 'merge refused: NOT_MERGEABLE a rejected, closed, banned or suspended company is not merged' using errcode = 'P0001'; end if;
  if a.kind <> s.kind then raise exception 'merge refused: KIND_MISMATCH the two companies are not the same kind' using errcode = 'P0001'; end if;
  if exists (select 1 from membership where organisation_id = a.id and status = 'active') then
    raise exception 'merge refused: ACTIVE_MEMBERS the absorbed company still has active members' using errcode = 'P0001'; end if;
  if exists (select 1 from application where organisation_id = a.id) then
    raise exception 'merge refused: HAS_APPLICATIONS the absorbed company has applications' using errcode = 'P0001'; end if;
  -- 0056 (S11): staff decide the absorbed company's open company reports first
  if exists (select 1 from report where target_organisation_id = a.id and status = 'open') then
    raise exception 'merge refused: OPEN_REPORTS the absorbed company has open reports: decide them first' using errcode = 'P0001'; end if;
  update organisation set merged_into_id = s.id where id = a.id;
  select coalesce(array_agg(id order by id), '{}') into v_names from organisation_name where organisation_id = a.id;
  update organisation_name set organisation_id = s.id where organisation_id = a.id;
  v_hist_before := s.permit_history;
  perform private.refresh_permit_history(); -- 0008: the one rule for the label and the sponsor sort, now over the moved names (and their DETE links)
  select permit_history into v_hist from organisation where id = s.id;
  select coalesce(array_agg(id order by id), '{}'), coalesce(jsonb_object_agg(id::text, posted_by_membership_id) filter (where posted_by_membership_id is not null), '{}')
    into v_jobs, v_posted from job where organisation_id = a.id;
  update job set organisation_id = s.id, posted_by_membership_id = null, permit_history = v_hist where organisation_id = a.id;
  -- 0056 (S11): the decided company reports and the strike cases follow the company, so its history and strike count do
  with m as (update report set target_organisation_id = s.id where target_organisation_id = a.id returning id) select coalesce(array_agg(id order by id), '{}') into v_reports from m;
  with m as (update strike set organisation_id = s.id where organisation_id = a.id returning id) select coalesce(array_agg(id order by id), '{}') into v_strikes from m;
  -- 0061 (SV-0): services cases, open or closed, follow the company (a case belongs to its requester; the company is context)
  with m as (update services_case set organisation_id = s.id where organisation_id = a.id returning id) select coalesce(array_agg(id order by id), '{}') into v_cases from m;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source)
    values ('admin_action', p_staff, 'organisation.merge', 'organisation', a.id::text, '{merged_into_id}',
            jsonb_build_object('merged_into_id', null, 'survivor_permit_history', v_hist_before),
            jsonb_build_object('merged_into_id', s.id, 'name_ids', to_jsonb(v_names), 'job_ids', to_jsonb(v_jobs), 'job_posted_by_membership', v_posted, 'survivor_permit_history', v_hist,
                               'report_ids', to_jsonb(v_reports), 'strike_ids', to_jsonb(v_strikes),
                               'case_ids', to_jsonb(v_cases)), -- 0061
            'panel');
  return jsonb_build_object('absorbed', a.id, 'survivor', s.id, 'names', cardinality(v_names), 'jobs', cardinality(v_jobs));
end $$;

reset role;
