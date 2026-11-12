-- Companies (step 13 part 13c; #232, #234 D1 and D6). Three things:
--   1. D1, name merges: private.merge_organisations merges one company into another in one transaction (merged_into_id first, then the names, jobs and DETE
--      links move, one audit row holds every moved id). private.claim_organisation (copied from 0016, the newest) and private.register_organisation (copied
--      from 0015, the newest) refuse a company merged away: the one open bug the merge left (a merged company could still be claimed or registered again).
--   2. #232, manual posting: the job_source row a staff post points to. No other database change: job_guard (0019) only restricts app_portal, app_fetcher and
--      the fetcher, so an app_admin insert with source 'admin_manual' and posted_by_staff_id passes it, and a portal post still needs a valid member.
--   3. D6, an owner who cannot be reached (20b "Account owner leaves"): the table owner_reassign and three functions (request, complete, cancel). Every
--      membership write is a function (#184); the completion copies team_transfer (0013): the old owner becomes a recruiter and keeps the signer switch.
-- Each new function takes the acting staff id and checks the person is active staff with the right role itself (private.companies_staff_check), then writes one
-- audit_event row of codes and ids (#182). A refusal raises '<what> refused: CODE ...'; the TypeScript wrapper turns CODE into its reply.
set role portal_owner;

-- The acting staff member: active, and holding one of the roles. Two codes: NOT_ACTIVE_STAFF, then the code the caller names for a missing role.
create function private.companies_staff_check(p_staff text, p_roles text[], p_code text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_staff is null or not exists (select 1 from staff_user where id = p_staff and status = 'active') then
    raise exception 'staff refused: NOT_ACTIVE_STAFF' using errcode = 'P0001'; end if;
  if not exists (select 1 from staff_role where staff_user_id = p_staff and role = any(p_roles)) then
    raise exception 'staff refused: %', p_code using errcode = 'P0001'; end if;
end $$;

-- ===== 1. merges
insert into job_source(kind, board) values ('admin', 'manual') on conflict (kind, board) do nothing;
-- The manual posts list (apps/admin /api/manual-jobs) pages by id over these rows only; without this index it would walk the whole job table for a handful of rows.
create index job_manual_idx on job(id desc) where source = 'admin_manual';

-- A merge, by an account reviewer or a fetched-job reviewer alone. Refused: a company merged already or into itself, a survivor that is itself merged, a
-- company that is rejected, closed, banned or suspended, two kinds, an absorbed company with an active member (organisation_merge_check refuses it too) or with
-- applications (a job with applications cannot change company: application points to job and company together).
-- Order (23-database-design.md, organisation): merged_into_id first, so the CRO rule already skips the absorbed side when its CRO-numbered name moves; then the
-- names (the DETE links point to the name rows and move with them), then the jobs. A job's poster membership belongs to the absorbed company, so it is emptied on
-- the move; the audit row keeps every moved id and every emptied poster, so a merge can be reversed by hand. The survivor's permit history and sponsor sort
-- are set by private.refresh_permit_history() (0008, the one rule), now that the names and their DETE links have moved; its trigger copies the label onto the
-- survivor's jobs, and the moved jobs take the survivor's value.
create function private.merge_organisations(p_staff text, p_absorbed bigint, p_survivor bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a organisation; s organisation; v_names bigint[]; v_jobs bigint[]; v_posted jsonb; v_hist_before text; v_hist text;
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
  update organisation set merged_into_id = s.id where id = a.id;
  select coalesce(array_agg(id order by id), '{}') into v_names from organisation_name where organisation_id = a.id;
  update organisation_name set organisation_id = s.id where organisation_id = a.id;
  v_hist_before := s.permit_history;
  perform private.refresh_permit_history(); -- 0008: the one rule for the label and the sponsor sort, now over the moved names (and their DETE links)
  select permit_history into v_hist from organisation where id = s.id;
  select coalesce(array_agg(id order by id), '{}'), coalesce(jsonb_object_agg(id::text, posted_by_membership_id) filter (where posted_by_membership_id is not null), '{}')
    into v_jobs, v_posted from job where organisation_id = a.id;
  update job set organisation_id = s.id, posted_by_membership_id = null, permit_history = v_hist where organisation_id = a.id;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source)
    values ('admin_action', p_staff, 'organisation.merge', 'organisation', a.id::text, '{merged_into_id}',
            jsonb_build_object('merged_into_id', null, 'survivor_permit_history', v_hist_before),
            jsonb_build_object('merged_into_id', s.id, 'name_ids', to_jsonb(v_names), 'job_ids', to_jsonb(v_jobs), 'job_posted_by_membership', v_posted, 'survivor_permit_history', v_hist),
            'panel');
  return jsonb_build_object('absorbed', a.id, 'survivor', s.id, 'names', cardinality(v_names), 'jobs', cardinality(v_jobs));
end $$;

-- claim_organisation and register_organisation: each is its newest text (0016 and 0015) with the lines marked 0022 added.
create or replace function private.claim_organisation(p_portal_user_id text, p_organisation_id bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_status text; v_mem bigint;
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'claim refused: unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'claim refused: email not verified' using errcode = 'P0001'; end if;
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'claim refused: email domain is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_address = lower(u.email)) then raise exception 'claim refused: email address is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban b where b.cro_number in (select o.cro_number from organisation o where o.id = p_organisation_id
             union select n.cro_number from organisation_name n where n.organisation_id = p_organisation_id)) then
    raise exception 'claim refused: company number is banned' using errcode = 'P0001'; end if;
  -- 0022 (D1, #234): a company merged into another can no longer be claimed; the survivor is the one to claim
  if exists (select 1 from organisation where id = p_organisation_id and merged_into_id is not null) then
    raise exception 'claim refused: MERGED this company was merged into another company' using errcode = 'P0001'; end if;
  -- 0016 (#203): the same login cannot claim the same company again within 24 hours of a rejection. The record is the login's removed owner membership
  -- (the organisation guard removes it when a reviewer rejects a claim) matched to that company's rejected account_review item by the instant they share:
  -- both are set with now() in the rejecting transaction. A claim that lapsed unanswered (outcome needs_info_expired) is not a rejection.
  if exists (select 1 from membership m join review_item r on r.organisation_id = m.organisation_id and r.queue = 'account_review' and r.outcome = 'rejected' and r.decided_at = m.removed_at
              where m.organisation_id = p_organisation_id and m.portal_user_id = p_portal_user_id and m.status = 'removed' and m.removed_at > now() - interval '24 hours') then
    raise exception 'claim refused: COOL_DOWN this login''s claim of this company was rejected within 24 hours' using errcode = 'P0001'; end if;
  v_status := case when exists (select 1 from organisation_domain d where d.organisation_id = p_organisation_id and d.domain = v_domain)
                    and not exists (select 1 from organisation_domain d where d.domain = v_domain and d.organisation_id <> p_organisation_id)
               then 'verified' else 'pending_review' end;
  update organisation set status = v_status, claimed_at = now(), signup_path = 'dete_claim', verified_at = case when v_status = 'verified' then now() end
   where id = p_organisation_id and status = 'unclaimed' and merged_into_id is null;  -- 0022: and not merged
  if not found then raise exception 'claim refused: organisation is not unclaimed' using errcode = 'P0001'; end if;
  insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values (p_organisation_id, p_portal_user_id, 'account_owner', 'active', true, now()) returning id into v_mem;
  if v_status = 'pending_review' then insert into review_item(queue, organisation_id, reason) values ('account_review', p_organisation_id, 'claim') on conflict do nothing; end if;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, after, source)
    values ('security', p_portal_user_id, 'organisation.claim', 'organisation', p_organisation_id::text, jsonb_build_object('status', v_status), 'site');
  return jsonb_build_object('organisation_id', p_organisation_id, 'status', v_status, 'membership_id', v_mem);
end $$;
create or replace function private.register_organisation(p_portal_user_id text, p_kind text, p_display_name text, p_cro_number text, p_wrc_licence_number text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_org bigint; v_mem bigint; found_in_register boolean; v_slug text; v_base text; v_try integer := 1;
  v_cro text; v_wrc text; v_status text; v_lapsed boolean; v_matches boolean; v_key text;  -- 0014
begin
  select * into u from portal_user where id = p_portal_user_id;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'sign-up refused: unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'sign-up refused: email not verified' using errcode = 'P0001'; end if;
  if p_kind not in ('employer','agency') then raise exception 'sign-up refused: kind must be employer or agency' using errcode = 'P0001'; end if;
  -- 0014: typed numbers cleaned (#210). CRO: spaces and a leading IE removed, leading zeros dropped. WRC: spaces removed, upper case, EA added to bare digits.
  v_cro := regexp_replace(regexp_replace(regexp_replace(p_cro_number, '\s+', '', 'g'), '^ie', '', 'i'), '^0+(?=\d)', '');
  v_wrc := upper(regexp_replace(p_wrc_licence_number, '\s+', '', 'g'));
  if v_wrc ~ '^\d+$' then v_wrc := 'EA' || v_wrc; end if;
  v_key := private.normalise_company_name(p_display_name);
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'sign-up refused: email domain is banned' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_address = lower(u.email)) then raise exception 'sign-up refused: email address is banned' using errcode = 'P0001'; end if;
  if v_cro is not null and exists (select 1 from ban where cro_number = v_cro) then raise exception 'sign-up refused: company number is banned' using errcode = 'P0001'; end if;
  -- 0022 (D1, #234): a number that belongs to a company merged into another is not registered again; the survivor is the one to claim (a null number matches nothing)
  if exists (select 1 from organisation m where m.merged_into_id is not null and case p_kind when 'employer' then m.cro_number = v_cro else m.wrc_licence_number = v_wrc end) then
    raise exception 'sign-up refused: MERGED this company number belongs to a company merged into another company' using errcode = 'P0001'; end if;
  -- 0014: the register result: found, its status (trimmed), and whether the name matches. A "leaving" status or a lapsed licence only shows; staff decide.
  if p_kind = 'employer' then
    select true, btrim(status), normalised_name = v_key into found_in_register, v_status, v_matches from cro_company where cro_number = v_cro;
  else
    select true, missed_imports >= 2,
           v_key <> '' and (private.normalise_company_name(agency_name) = v_key or private.normalise_company_name(trading_name) = v_key)
      into found_in_register, v_lapsed, v_matches from wrc_licence where licence_number = v_wrc;
  end if;
  -- slug: the lower-case words of display_name joined by hyphens, with -2, -3 added on a clash (organisation)
  v_base := btrim(lower(regexp_replace(p_display_name, '[^a-zA-Z0-9]+', '-', 'g')), '-'); v_slug := v_base;
  while exists (select 1 from organisation where slug = v_slug) loop v_try := v_try + 1; v_slug := v_base || '-' || v_try; end loop;
  insert into organisation(slug, display_name, kind, status, signup_path, cro_number, wrc_licence_number, claimed_at)
    values (v_slug,
            p_display_name, p_kind, 'pending_review', case when p_kind = 'employer' then 'first_time' else 'agency' end,
            case when p_kind = 'employer' then v_cro end, case when p_kind = 'agency' then v_wrc end, now()) returning id into v_org;
  insert into membership(organisation_id, portal_user_id, role, status, is_signer, joined_at) values (v_org, p_portal_user_id, 'account_owner', 'active', true, now()) returning id into v_mem;
  insert into review_item(queue, organisation_id, reason, detail) values ('account_review', v_org, 'new organisation',
    jsonb_strip_nulls(jsonb_build_object('register', case when p_kind = 'employer' then 'cro_company' else 'wrc_licence' end, 'found', coalesce(found_in_register, false),
                       'name_matches', coalesce(v_matches, false), 'status', v_status, 'possibly_lapsed', v_lapsed)));  -- 0014
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source)
    values ('security', p_portal_user_id, 'organisation.register', 'organisation', v_org::text, 'site');
  return jsonb_build_object('organisation_id', v_org, 'status', 'pending_review', 'membership_id', v_mem, 'found_in_register', coalesce(found_in_register, false));
end $$;

-- ===== 3. an owner who cannot be reached (D6)
-- One row per request. The reviewer ticks that the company domain and the CRO number were checked (both columns must be true). completes_after is 7 days after
-- the request: the old owner gets a notice now, and an account reviewer may complete the change only after it. One open request per company. Written only by the
-- three functions below; app_admin reads. No index on the staff columns or on organisation_id alone: the staff are never deleted and no stated query filters by them.
create table owner_reassign(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id),
  new_owner_membership_id bigint not null references membership(id), old_owner_membership_id bigint not null references membership(id), -- the functions keep both in the company
  domain_checked boolean not null, cro_checked boolean not null,
  requested_by_staff_user_id text not null references staff_user(id), requested_at timestamptz not null default now(), completes_after timestamptz not null,
  status text not null default 'open' check (status in ('open','done','cancelled')),
  decided_by_staff_user_id text references staff_user(id), decided_at timestamptz,
  check (domain_checked and cro_checked), check (new_owner_membership_id <> old_owner_membership_id),
  check (completes_after >= requested_at + interval '7 days'),
  check ((status = 'open') = (decided_by_staff_user_id is null and decided_at is null)));
create unique index owner_reassign_one_open on owner_reassign(organisation_id) where status = 'open';
revoke all on owner_reassign from public, anon, authenticated, service_role;
grant select on owner_reassign to app_admin;

-- The reviewer records a member's request. Refusals: NOT_CHECKED, MEMBER_NOT_FOUND (also another status), ALREADY_OWNER, COMPANY_NOT_OPEN, NO_OWNER,
-- USER_NOT_ACTIVE (the new owner's login is blocked or deleted), REQUEST_OPEN. The notice to the old owner holds ids only (no names, #182).
create function private.owner_reassign_request(p_staff text, p_membership bigint, p_domain_checked boolean, p_cro_checked boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n membership; o organisation; old membership; v_id bigint; v_after timestamptz := now() + interval '7 days';
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_ACCOUNT_REVIEWER');
  if p_domain_checked is not true or p_cro_checked is not true then
    raise exception 'owner reassign refused: NOT_CHECKED the company domain and the CRO number must both be checked' using errcode = 'P0001'; end if;
  select * into n from membership where id = p_membership;
  if n.id is null then raise exception 'owner reassign refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = n.organisation_id for no key update; -- as the team functions: the company first, then read the rows again
  select * into n from membership where id = p_membership;
  select * into o from organisation where id = n.organisation_id;
  if n.status <> 'active' then raise exception 'owner reassign refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  if n.role = 'account_owner' then raise exception 'owner reassign refused: ALREADY_OWNER' using errcode = 'P0001'; end if;
  if o.merged_into_id is not null or not private.team_open(o.status) then raise exception 'owner reassign refused: COMPANY_NOT_OPEN' using errcode = 'P0001'; end if;
  select * into old from membership where organisation_id = o.id and role = 'account_owner' and status = 'active';
  if old.id is null then raise exception 'owner reassign refused: NO_OWNER' using errcode = 'P0001'; end if;
  if not exists (select 1 from portal_user where id = n.portal_user_id and status = 'active' and deleted_at is null) then
    raise exception 'owner reassign refused: USER_NOT_ACTIVE' using errcode = 'P0001'; end if;
  if exists (select 1 from owner_reassign where organisation_id = o.id and status = 'open') then
    raise exception 'owner reassign refused: REQUEST_OPEN' using errcode = 'P0001'; end if;
  insert into owner_reassign(organisation_id, new_owner_membership_id, old_owner_membership_id, domain_checked, cro_checked, requested_by_staff_user_id, completes_after)
    values (o.id, n.id, old.id, true, true, p_staff, v_after) returning id into v_id;
  insert into email_outbox(template, portal_user_id, params, dedupe_key)
    values ('owner_reassign_notice', old.portal_user_id, jsonb_build_object('organisationId', o.id, 'requestId', v_id, 'completesAfter', v_after), 'owner_reassign:' || v_id);
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, source)
    values ('admin_action', p_staff, 'owner_reassign.request', 'organisation', o.id::text,
            jsonb_build_object('request_id', v_id, 'new_owner_membership', n.id, 'old_owner_membership', old.id, 'domain_checked', true, 'cro_checked', true), 'panel');
  return jsonb_build_object('requestId', v_id, 'organisationId', o.id, 'completesAfter', v_after);
end $$;

-- After the 7 days an account reviewer completes it: the old owner becomes a recruiter and keeps the signer switch (team_transfer, 0013). Refusals: NOT_FOUND,
-- NOT_OPEN, TOO_EARLY, COMPANY_NOT_OPEN, OWNER_CHANGED (the owner is not the one the request named any more: cancel it), MEMBER_GONE, USER_NOT_ACTIVE.
create function private.owner_reassign_complete(p_staff text, p_request bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r owner_reassign; o organisation; n membership; old membership;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_ACCOUNT_REVIEWER');
  select * into r from owner_reassign where id = p_request;
  if r.id is null then raise exception 'owner reassign refused: NOT_FOUND' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = r.organisation_id for no key update;
  select * into r from owner_reassign where id = p_request for update;
  if r.status <> 'open' then raise exception 'owner reassign refused: NOT_OPEN' using errcode = 'P0001'; end if;
  if now() < r.completes_after then raise exception 'owner reassign refused: TOO_EARLY the 7 days have not passed' using errcode = 'P0001'; end if;
  select * into o from organisation where id = r.organisation_id;
  if o.merged_into_id is not null or not private.team_open(o.status) then raise exception 'owner reassign refused: COMPANY_NOT_OPEN' using errcode = 'P0001'; end if;
  select * into old from membership where id = r.old_owner_membership_id;
  if old.status <> 'active' or old.role <> 'account_owner' then raise exception 'owner reassign refused: OWNER_CHANGED' using errcode = 'P0001'; end if;
  select * into n from membership where id = r.new_owner_membership_id;
  if n.status <> 'active' then raise exception 'owner reassign refused: MEMBER_GONE' using errcode = 'P0001'; end if;
  if not exists (select 1 from portal_user where id = n.portal_user_id and status = 'active' and deleted_at is null) then
    raise exception 'owner reassign refused: USER_NOT_ACTIVE' using errcode = 'P0001'; end if;
  update membership set role = 'recruiter' where id = old.id; -- demote, then promote, in one transaction (one_owner_per_org)
  update membership set role = 'account_owner' where id = n.id;
  update owner_reassign set status = 'done', decided_by_staff_user_id = p_staff, decided_at = now() where id = r.id;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, before, after, source)
    values ('admin_action', p_staff, 'owner_reassign.complete', 'organisation', o.id::text,
            jsonb_build_object('request_id', r.id, 'owner_membership', old.id, 'new_owner_role', n.role),
            jsonb_build_object('owner_membership', n.id, 'old_owner_role', 'recruiter'), 'panel');
  return jsonb_build_object('requestId', r.id, 'organisationId', o.id, 'ownerMembershipId', n.id);
end $$;

-- Any account reviewer cancels an open request (the brief allows it within the 7 days; it is allowed after too, so a request that cannot be completed does not
-- block the company's next one). Refusals: NOT_FOUND, NOT_OPEN.
create function private.owner_reassign_cancel(p_staff text, p_request bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r owner_reassign;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_ACCOUNT_REVIEWER');
  select * into r from owner_reassign where id = p_request;
  if r.id is null then raise exception 'owner reassign refused: NOT_FOUND' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = r.organisation_id for no key update;
  select * into r from owner_reassign where id = p_request for update;
  if r.status <> 'open' then raise exception 'owner reassign refused: NOT_OPEN' using errcode = 'P0001'; end if;
  update owner_reassign set status = 'cancelled', decided_by_staff_user_id = p_staff, decided_at = now() where id = r.id;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, source)
    values ('admin_action', p_staff, 'owner_reassign.cancel', 'organisation', r.organisation_id::text, jsonb_build_object('request_id', r.id), 'panel');
  return jsonb_build_object('requestId', r.id, 'organisationId', r.organisation_id);
end $$;

revoke all on function private.companies_staff_check(text, text[], text), private.merge_organisations(text, bigint, bigint),
  private.owner_reassign_request(text, bigint, boolean, boolean), private.owner_reassign_complete(text, bigint), private.owner_reassign_cancel(text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function private.companies_staff_check(text, text[], text), private.merge_organisations(text, bigint, bigint),
  private.owner_reassign_request(text, bigint, boolean, boolean), private.owner_reassign_complete(text, bigint), private.owner_reassign_cancel(text, bigint) to app_admin;

reset role;
