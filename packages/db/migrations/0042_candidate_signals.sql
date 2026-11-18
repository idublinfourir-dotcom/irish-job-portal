-- Step 15 small wave 5: three database pieces.
--   1. S20: app_candidate may read job.hidden_reason (not hidden_report_id), so the saved and applied job reads can say why a job is not shown
--      (packages/db/src/candidate.ts JOB_REASON). The code only: never the report, the reporter or staff notes.
--   2. D6 (#49): dete_permit_rise, one row per DETE name and year whose cumulative count went up in a monthly import (importPermits with
--      replaceYears writes it before the upsert, in the same transaction). Staff only: app_admin reads and writes it, nothing public.
--   3. D8 (#212): fetched_advert.wrc_agency is true when the advert's employer name, normalised as the fetcher does it, is an agency or trading
--      name on the WRC licensed agency list. Set by a security definer trigger, because app_fetcher may not read wrc_licence (0014). Staff only
--      (app_admin reads fetched_advert; the candidate and portal roles cannot). The name pattern in @portal/rules stays as it is.
set role portal_owner;

grant select (hidden_reason) on job to app_candidate;

create table dete_permit_rise(
  id bigint generated always as identity primary key, found_at timestamptz not null default now(),
  dete_name text not null, year smallint not null, permits_before integer not null, permits_after integer not null,
  check (permits_after > permits_before));
create index dete_permit_rise_found_idx on dete_permit_rise(found_at);
grant select, insert on dete_permit_rise to app_admin;

alter table fetched_advert add column wrc_agency boolean not null default false;
create index wrc_licence_agency_norm_idx on wrc_licence(btrim(regexp_replace(lower(agency_name), '[^a-z0-9]+', ' ', 'g')));
create index wrc_licence_trading_norm_idx on wrc_licence(btrim(regexp_replace(lower(trading_name), '[^a-z0-9]+', ' ', 'g')));
-- ponytail: matched when the advert row is written; a WRC list import does not re-flag older adverts (the next rewrite of the advert does).
create function private.fetched_advert_wrc() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := btrim(regexp_replace(lower(coalesce(new.employer_name, '')), '[^a-z0-9]+', ' ', 'g'));
begin
  new.wrc_agency := k <> '' and exists (select 1 from wrc_licence w
    where btrim(regexp_replace(lower(w.agency_name), '[^a-z0-9]+', ' ', 'g')) = k or btrim(regexp_replace(lower(w.trading_name), '[^a-z0-9]+', ' ', 'g')) = k);
  return new;
end $$;
create trigger fetched_advert_wrc before insert or update on fetched_advert for each row execute function private.fetched_advert_wrc();

reset role;
