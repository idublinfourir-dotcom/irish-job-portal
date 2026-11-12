-- A ban can name one exact email address (#215): a company whose people use a free email provider (gmail.com and so on) is banned by its CRO
-- number plus the addresses of its people, never by the whole provider domain. The address is stored in lower case.
-- ban_matches_case accepts only the address of someone who joined the case organisation before the case opened (as #137 a does for domains).
-- claim_organisation and register_organisation also refuse a banned address: each is its latest text (claim_organisation from 0002, register_organisation from 0014) with one added line after the domain check.
-- report: a queue index for the staff list; the candidate and portal logins insert only the reporter's own columns, so a report cannot be filed as already decided or hidden.
set role portal_owner;

alter table ban add column email_address text;
alter table ban drop constraint ban_check;
alter table ban add constraint ban_check check (num_nonnulls(cro_number, email_domain, email_address) >= 1);
create unique index ban_address_unique on ban(email_address) where email_address is not null;

-- The staff reports queue lists open and job_hidden reports oldest first across both statuses; report_inbox_idx leads with status, so that order
-- read the whole table (2,180 pages on the page gate's fill). This index serves the order and the cursor directly.
create index report_queue_idx on report(created_at, id) where status in ('open','job_hidden');

revoke insert on report from app_candidate, app_portal;
grant insert (target_kind, target_job_id, reporter_candidate_user_id, reason, evidence_text, target_snapshot) on report to app_candidate;
grant insert (target_kind, target_job_id, reporter_portal_user_id, reason, evidence_text, target_snapshot) on report to app_portal;

create or replace function private.ban_matches_case() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare o organisation; opened timestamptz;
begin
  select o2.* into o from strike s join organisation o2 on o2.id = s.organisation_id where s.id = new.strike_id;
  select s.created_at into opened from strike s where s.id = new.strike_id;
  if new.cro_number is not null and new.cro_number is distinct from o.cro_number then
    raise exception 'ban refused: cro_number is not the case organisation''s' using errcode = 'P0001'; end if;
  -- #137 a: only a domain the organisation had before its case opened
  if new.email_domain is not null and not coalesce(exists (select 1 from organisation_domain d where d.organisation_id = o.id and d.domain = new.email_domain and d.created_at < opened), false) then
    raise exception 'ban refused: email_domain is not one of the case organisation''s domains from before the case opened' using errcode = 'P0001'; end if;
  -- #215: an exact address must be the login email of someone who joined the case organisation before the case opened
  if new.email_address is not null and not coalesce(exists (select 1 from membership m join portal_user u on u.id = m.portal_user_id
       where m.organisation_id = o.id and lower(u.email) = new.email_address and m.joined_at < opened), false) then
    raise exception 'ban refused: email_address is not the email of a member who joined the case organisation before the case opened' using errcode = 'P0001'; end if;
  return new;
end $$;

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

reset role;
