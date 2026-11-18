-- Step 15 gap agent 3 (staff tools follow-ups). Tests: packages/db/test/staff-tools.test.ts, packages/fetcher/test/wrc-agency.test.ts.
set role portal_owner;

-- Q14: the panel's company seed marks its confirmed request used, in the seed's own transaction, so a request is applied once only. Owner's rights for
-- this one kind and target: app_admin cannot mark any other request used (use_approval itself stays uncallable).
create function private.use_company_seed(p_request bigint) returns bigint language sql security definer set search_path = public, pg_temp as $$
  select private.use_approval(p_request, 'company_seed', 'organisation', 'company_seed');
$$;
revoke all on function private.use_company_seed(bigint) from public;
grant execute on function private.use_company_seed(bigint) to app_admin;

-- Q14: the database two-person rule guards the seed's writes, as setting_guard guards a setting. app_admin's only inserts into organisation and
-- organisation_name are the seed's (company-seed.ts), so each insert statement by app_admin needs a company_seed request used in the same
-- transaction (approval_request_guard lets applied_at be set only to now(), the transaction's start). The owner login (company-seed-cli.ts,
-- migrations) is not app_admin and is not held. Merges and renames are updates and stay as they are.
create function private.company_seed_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from approval_request where kind = 'company_seed' and applied_at = now()) then
    raise exception 'two-person rule: % rows are added only by a confirmed company_seed request used in this transaction', tg_table_name using errcode = 'P0001'; end if;
  return null;
end $$;
create trigger organisation_seed_guard before insert on organisation for each statement when (current_user = 'app_admin') execute function private.company_seed_guard();
create trigger organisation_name_seed_guard before insert on organisation_name for each statement when (current_user = 'app_admin') execute function private.company_seed_guard();

-- D8: after each WRC list import (wrc-import.ts, same transaction) the adverts still open (gone_at empty) are flagged again against the list, with
-- the same normalised-name test as the advert trigger (0042). The list's names are read once (a hash); only rows whose flag changes are written (the
-- trigger then sets the same value). Returns the number changed. Owner's rights: app_admin may not update the flag itself.
create function private.refresh_wrc_agency() returns integer language sql security definer set search_path = public, pg_temp as $$
  with names as (
    select btrim(regexp_replace(lower(agency_name), '[^a-z0-9]+', ' ', 'g')) as k from wrc_licence
    union select btrim(regexp_replace(lower(trading_name), '[^a-z0-9]+', ' ', 'g')) from wrc_licence where trading_name is not null),
  u as (update fetched_advert f set wrc_agency = not f.wrc_agency where f.gone_at is null
    and f.wrc_agency <> coalesce(btrim(regexp_replace(lower(coalesce(f.employer_name, '')), '[^a-z0-9]+', ' ', 'g')) in (select k from names where k <> ''), false)
    returning 1)
  select count(*)::int from u;
$$;
revoke all on function private.refresh_wrc_agency() from public;
grant execute on function private.refresh_wrc_agency() to app_admin;

reset role;
