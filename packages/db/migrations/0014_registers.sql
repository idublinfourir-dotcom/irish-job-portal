-- The CRO and WRC registers and the register check at employer and agency sign-up (slice 8.2b, decisions #185, #207 to #212).
-- cro_company gains the company type and county (#211). wrc_licence gains missed_imports (a licence missing from two lists in a row is
-- "possibly lapsed", shown to staff only). register_import remembers what each importer last read. register_organisation (copied from 0002;
-- only the lines marked "0014" differ) cleans the typed number, writes the register result into the review item, and compares names on the
-- same key the importer stores. Nothing new is refused: a number not in the register still goes to review, marked "not found".
set role portal_owner;

alter table cro_company add column company_type text, add column county text;
-- The weekly import rewrites last_seen_on on every row; spare room on each page lets those updates stay on the page (no index changes, less bloat).
alter table cro_company set (fillfactor = 85);
alter table wrc_licence add column missed_imports smallint not null default 0 check (missed_imports >= 0);

create table register_import(
  source text primary key check (source in ('cro','wrc')), validator text, imported_on date not null, row_count integer not null check (row_count >= 0));
revoke all on register_import from public, anon, authenticated, service_role;
grant select, insert, update on register_import to app_fetcher, app_admin;

-- The WRC list is for the staff check only (#212): no portal or fetcher read. register_organisation reads it as its owner.
revoke select on wrc_licence from app_portal, app_fetcher;

-- The key two company names are compared on. The same rule is in src/registers.ts (normaliseCompanyName); test/registers.test.ts runs both.
create function private.normalise_company_name(p text) returns text language sql immutable set search_path = pg_catalog as $$
  select coalesce(nullif(regexp_replace(k, '(?: (?:ltd|limited|dac|clg|plc|ulc|teoranta|teo|designated activity company|company limited by guarantee|public limited company|unlimited company))+$', ''), ''), k)
  from (select btrim(regexp_replace(replace(lower(translate(p, 'ÁÉÍÓÚáéíóú', 'aeiouaeiou')), '&', ' and '), '[^a-z0-9]+', ' ', 'g')) as k) s
$$;
revoke all on function private.normalise_company_name(text) from public, anon, authenticated, service_role;

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
