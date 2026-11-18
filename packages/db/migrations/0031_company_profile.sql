-- Step 15 audit rows P3, P12 and P13: the owner edits the company profile and logo, the owner closes the company, and staff set the member limit.
--   1. P3: private.company_edit (description, website, county) and private.company_logo (the stored logo's key). The account owner only (private.team_owner,
--      0013: the team code lets no other role manage the company), of a company that can take on people (private.team_open). Name, CRO number, status,
--      verification and slug are not arguments, and app_portal loses its column update grant on organisation (0003), so the portal can change nothing else.
--      The logo is a file in the files bucket under logo/<uuid>.<png|jpg|webp>; the key is organisation.logo_key (new). One audit row of column names only (#182).
--   2. P12: private.company_close. The active account owner, with the company's exact name typed back. In one transaction: the company's open employer and
--      agency jobs close (reason 'closed', as the owner's own job close), its open review items are dropped (outcome 'organisation_closed'), every membership
--      ends (active members removed, invites and join requests cancelled), the company becomes 'closed' (already in the status list), every active member gets
--      a portal notice and a pending email, and one audit row holds the counts. Nothing is deleted: the jobs, memberships and files stay (business records).
--   3. P13: private.member_limit_set. An account reviewer or an administrator sets member_limit (1 to 50, never below the active members), with a reason code.
set role portal_owner;

alter table organisation add column logo_key text check (logo_key ~ '^logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg|webp)$');
alter table organisation add constraint organisation_member_limit_check check (member_limit between 1 and 50); -- 50: the hard maximum (#103 guess)

revoke update on organisation from app_portal;

-- ===== 1. the profile
create function private.company_edit(p_user text, p_description text, p_website text, p_county text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation; v_cols text[];
begin
  m := private.team_owner(p_user); -- the active account owner, after locking the company
  select * into o from organisation where id = m.organisation_id;
  if not private.team_open(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  -- the route checks every field; these are the last word on the two that matter most if the route were wrong
  if length(p_description) > 2000 or p_website !~ '^https://[^/?#@\s]+\.[^/?#@\s]+' then raise exception 'company refused: BAD_REQUEST' using errcode = 'P0001'; end if;
  v_cols := array_remove(array[
    case when o.short_description is distinct from p_description then 'short_description' end,
    case when o.website is distinct from p_website then 'website' end,
    case when o.county is distinct from p_county then 'county' end], null);
  update organisation set short_description = p_description, website = p_website, county = p_county where id = o.id;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, source)
    values ('security', p_user, 'organisation.profile', 'organisation', o.id::text, v_cols, 'site');
  return jsonb_build_object('organisationId', o.id, 'changed', to_jsonb(v_cols));
end $$;

-- The logo: the route stores the new file first, then calls this; the reply names the old key, which the route then removes from the bucket.
create function private.company_logo(p_user text, p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation;
begin
  m := private.team_owner(p_user);
  select * into o from organisation where id = m.organisation_id;
  if not private.team_open(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  update organisation set logo_key = p_key where id = o.id; -- the column's check refuses any other key shape
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, source)
    values ('security', p_user, 'organisation.logo', 'organisation', o.id::text, '{logo_key}', 'site');
  return jsonb_build_object('organisationId', o.id, 'oldKey', o.logo_key);
end $$;

-- ===== 2. the owner closes the company
create function private.company_close(p_user text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation; v_members text[]; v_jobs integer; v_items integer; v_ended integer; v_cancelled integer;
begin
  m := private.team_owner(p_user);
  select * into o from organisation where id = m.organisation_id;
  if not private.team_open(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if p_name is distinct from o.display_name then raise exception 'company refused: NAME_MISMATCH' using errcode = 'P0001'; end if;
  select coalesce(array_agg(portal_user_id order by id), '{}') into v_members from membership where organisation_id = o.id and status = 'active';
  -- job_queue_review (0028) drops each closed job's own scam, post-strike and client items; the statement below drops the rest
  update job set status = 'closed', closed_at = now(), close_reason = 'closed'
   where organisation_id = o.id and source in ('employer','agency') and status in ('draft','in_review','live','under_review');
  get diagnostics v_jobs = row_count;
  update review_item set status = 'dropped', outcome = 'organisation_closed', decided_at = now()
   where status in ('open','claimed') and (organisation_id = o.id or job_id in (select id from job where organisation_id = o.id)
     or pay_floor_id in (select id from pay_floor where organisation_id = o.id));
  get diagnostics v_items = row_count;
  update membership set status = 'removed', removed_at = now() where organisation_id = o.id and status = 'active';
  get diagnostics v_ended = row_count;
  update membership set status = 'removed', removed_at = now(), invited_email = null, invite_token_hash = null
   where organisation_id = o.id and status in ('invited','join_requested','awaiting_approval');
  get diagnostics v_cancelled = row_count;
  update organisation set status = 'closed' where id = o.id;
  insert into notification(portal_user_id, organisation_id, category, template_key, params)
    select u, o.id, 'account', 'organisation_closed', jsonb_build_object('organisationId', o.id) from unnest(v_members) u;
  insert into email_outbox(template, portal_user_id, params, dedupe_key)
    select 'organisation_closed', u, jsonb_build_object('organisationId', o.id), 'organisation_closed:' || o.id || ':' || u from unnest(v_members) u;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, before, after, source)
    values ('security', p_user, 'organisation.close', 'organisation', o.id::text, '{status}', jsonb_build_object('status', o.status),
            jsonb_build_object('status', 'closed', 'jobs_closed', v_jobs, 'items_dropped', v_items, 'memberships_ended', v_ended, 'invites_cancelled', v_cancelled), 'site');
  return jsonb_build_object('organisationId', o.id, 'jobsClosed', v_jobs, 'itemsDropped', v_items, 'membershipsEnded', v_ended, 'invitesCancelled', v_cancelled);
end $$;

-- ===== 3. the member limit
-- Refusals: NOT_ACTIVE_STAFF, NOT_LIMIT_STAFF, BAD_REASON, BAD_LIMIT (outside 1 to 50), NOT_FOUND, BELOW_ACTIVE (fewer than the active members).
create function private.member_limit_set(p_staff text, p_org bigint, p_limit integer, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation; v_active integer;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer','administrator'], 'NOT_LIMIT_STAFF');
  if p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,62}$' then raise exception 'member limit refused: BAD_REASON' using errcode = 'P0001'; end if;
  if p_limit is null or p_limit not between 1 and 50 then raise exception 'member limit refused: BAD_LIMIT' using errcode = 'P0001'; end if;
  select * into o from organisation where id = p_org for no key update; -- as the team functions: an invite waits, then counts against the new limit
  if o.id is null then raise exception 'member limit refused: NOT_FOUND' using errcode = 'P0001'; end if;
  select count(*) into v_active from membership where organisation_id = o.id and status = 'active';
  if p_limit < v_active then raise exception 'member limit refused: BELOW_ACTIVE' using errcode = 'P0001'; end if;
  update organisation set member_limit = p_limit where id = o.id;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, reason_code, source)
    values ('admin_action', p_staff, 'organisation.member_limit', 'organisation', o.id::text, '{member_limit}',
            jsonb_build_object('member_limit', o.member_limit), jsonb_build_object('member_limit', p_limit), p_reason, 'panel');
  return jsonb_build_object('organisationId', o.id, 'memberLimit', p_limit, 'activeMembers', v_active);
end $$;

revoke all on function private.company_edit(text, text, text, text), private.company_logo(text, text), private.company_close(text, text),
  private.member_limit_set(text, bigint, integer, text) from public, anon, authenticated, service_role;
grant execute on function private.company_edit(text, text, text, text), private.company_logo(text, text), private.company_close(text, text) to app_portal;
grant execute on function private.member_limit_set(text, bigint, integer, text) to app_admin;

reset role;
