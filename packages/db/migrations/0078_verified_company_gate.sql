-- Audit of 27 Nov 2026, SEC-1 (option 1, section 13): the public-facing owner actions only once staff have verified the company.
-- A claim of an unclaimed company makes the claimant its active account owner at once, while the company waits in pending_review. The four
-- owner functions checked private.team_open, which counts pending_review and needs_info as open, so an unverified claimant could put a website,
-- text and logo on a real sponsor's public page, close it for good, or hide agency jobs that name it.
--   1. private.company_live: true only for verified and verified_restricted.
--   2. company_edit, company_logo (three arguments, 0074), company_close: company_live in place of team_open. client_not_recognised (0059): the
--      same check, before the job lookup, so an unverified owner cannot even probe job ids. Signatures, replies and grants are unchanged.
--   3. organisation_guard (0010): a move to unclaimed or rejected also clears website, short_description, logo_key and logo_url, so a rejected
--      claim leaves nothing of the claimant's on the public page. The rest of the function is unchanged.
--   4. The rows already unclaimed or rejected get the same clear once.
--   5. company_edit's own website check is anchored: the host part must end at the end or at / ? #, so a dotted userinfo is refused (found
--      by this slice's hostile-input test; the portal route already refused it).
-- Not changed: private.team_open and the team functions (a pending owner may still invite people; section 13 names only these four actions),
-- county (a plain county name), the public read queries, and the jobs and Apply links of unclaimed companies.
set role portal_owner;

-- ===== 1. the verified company
create function private.company_live(p_status text) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_status in ('verified','verified_restricted');
$$;

-- ===== 2. the four owner actions
create or replace function private.company_edit(p_user text, p_description text, p_website text, p_county text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation; v_cols text[];
begin
  m := private.team_owner(p_user); -- the active account owner, after locking the company
  select * into o from organisation where id = m.organisation_id;
  if not private.company_live(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  -- the route checks every field; these are the last word on the two that matter most if the route were wrong
  -- 0078: the host part ends at the end or at / ? #, so a dotted userinfo (https://fake.example@evil.example) is refused here too, not only by the route
  if length(p_description) > 2000 or p_website !~ '^https://[^/?#@\s]+\.[^/?#@\s]+([/?#].*)?$' then raise exception 'company refused: BAD_REQUEST' using errcode = 'P0001'; end if;
  v_cols := array_remove(array[
    case when o.short_description is distinct from p_description then 'short_description' end,
    case when o.website is distinct from p_website then 'website' end,
    case when o.county is distinct from p_county then 'county' end], null);
  update organisation set short_description = p_description, website = p_website, county = p_county where id = o.id;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, source)
    values ('security', p_user, 'organisation.profile', 'organisation', o.id::text, v_cols, 'site');
  return jsonb_build_object('organisationId', o.id, 'changed', to_jsonb(v_cols));
end $$;

create or replace function private.company_logo(p_user text, p_key text, p_url text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation;
begin
  m := private.team_owner(p_user);
  select * into o from organisation where id = m.organisation_id;
  if not private.company_live(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if p_url is null or length(p_url) > 300 or p_url !~ '^https?://[^/?#\s]+/api/portal/company/logo/[0-9a-f-]{36}\.(png|jpg|webp)$' or p_url not like '%' || substr(p_key, 6) then
    raise exception 'company refused: BAD_REQUEST logo address' using errcode = 'P0001'; end if;
  update organisation set logo_key = p_key, logo_url = p_url where id = o.id; -- the column's check refuses any other key shape
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, source)
    values ('security', p_user, 'organisation.logo', 'organisation', o.id::text, '{logo_key,logo_url}', 'site');
  return jsonb_build_object('organisationId', o.id, 'oldKey', o.logo_key);
end $$;

create or replace function private.company_close(p_user text, p_name text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation; v_members text[]; v_jobs integer; v_items integer; v_ended integer; v_cancelled integer;
begin
  m := private.team_owner(p_user);
  select * into o from organisation where id = m.organisation_id;
  if not private.company_live(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
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

create or replace function private.client_not_recognised(p_user text, p_job bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user); j job; v_report bigint;
begin
  if m.role <> 'account_owner' then raise exception 'client report refused: NOT_OWNER' using errcode = 'P0001'; end if;
  -- for share: a staff decision on the company's status waits for this press, or this press sees the decision
  if not private.company_live((select status from organisation where id = m.organisation_id for share)) then
    raise exception 'client report refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  select x.* into j from job x join organisation_name n on n.id = x.permit_employer_name_id
   where x.id = p_job and n.organisation_id = m.organisation_id and x.organisation_id <> m.organisation_id
     and x.source = 'agency' and x.permit_employer_kind = 'client' for update of x;
  if j.id is null then raise exception 'client report refused: JOB_NOT_FOUND' using errcode = 'P0001'; end if;
  -- a second press (any owner of the client) gets the same answer and writes nothing; the job row lock above orders two presses at once
  select id into v_report from report where target_job_id = j.id and reason = 'not_recognised' and status in ('open','job_hidden');
  if v_report is not null then return jsonb_build_object('reportId', v_report, 'hidden', j.status = 'hidden'); end if;
  if j.status not in ('live','under_review') then raise exception 'client report refused: JOB_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into report(target_kind, target_job_id, reporter_portal_user_id, reason, status, target_snapshot)
    values ('job', j.id, p_user, 'not_recognised', case when j.status = 'live' then 'job_hidden' else 'open' end,
            jsonb_build_object('title', j.title, 'employer_name', j.employer_name, 'badge', j.badge, 'salary_low', j.salary_low, 'salary_high', j.salary_high,
              'pay_grade', j.pay_grade, 'closes_at', j.closes_at, 'client_organisation_id', m.organisation_id))
    returning id into v_report;
  if j.status = 'live' then
    update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = v_report where id = j.id;
    with u as (select distinct mm.portal_user_id as p from membership mm where mm.organisation_id = j.organisation_id and mm.status = 'active'
                 and (mm.role = 'account_owner' or mm.id = j.posted_by_membership_id)),
         n as (insert into notification(portal_user_id, organisation_id, category, template_key, params)
                 select p, j.organisation_id, 'account', 'job_hidden', jsonb_build_object('organisationId', j.organisation_id, 'jobId', j.id) from u)
    insert into email_outbox(template, portal_user_id, params) select 'job_hidden', p, jsonb_build_object('organisationId', j.organisation_id, 'jobId', j.id) from u;
  end if;
  return jsonb_build_object('reportId', v_report, 'hidden', j.status = 'live');
end $$;

-- ===== 3. a rejected claim clears what the claimant put on the public page
create or replace function private.organisation_guard()
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
      -- 0078 (SEC-1): nothing the claimant wrote stays on the public page; the logo file stays in the bucket, unreferenced, so the public route answers 404
      new.website := null; new.short_description := null; new.logo_key := null; new.logo_url := null;
    end if;
    if new.status = 'unclaimed' then
      new.claimed_at := null; new.verified_at := null; new.signup_path := null;
      -- only the company's own posts: fetched and staff-made jobs are not the claimant's (a fetched one waits in the admin queue as in_review)
      update job set status = 'closed', closed_at = now(), close_reason = 'removed'
       where organisation_id = new.id and status in ('draft','in_review') and source in ('employer','agency');
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

-- ===== 4. the rows already unclaimed or rejected (live on 27 Nov 2026: none has a website or logo)
update organisation set website = null, short_description = null, logo_key = null, logo_url = null
 where status in ('unclaimed','rejected') and (website is not null or short_description is not null or logo_key is not null or logo_url is not null);

reset role;
