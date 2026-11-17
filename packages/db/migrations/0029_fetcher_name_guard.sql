-- Company seed (D2, #246): the fetcher writes only the names it finds in adverts. 0003 gave app_fetcher insert on all of organisation_name, so it
-- could also write a legal name from 'dete' or a name from 'admin', which only staff tools (the company seed, dete-cli link) should make: a DETE
-- legal name decides which company the permit counts belong to. A column grant cannot limit a value, so a trigger does, the way job_guard limits the
-- fetcher by current_user (not security definer, so current_user is the caller). No other role changes: app_portal and app_candidate have no
-- insert on organisation_name, and only app_admin may update dete_permit_count (0003). app_admin needs no new grant for the seed: it has select,
-- insert and update on organisation and every right on organisation_name and dete_permit_count (0003).
set role portal_owner;

create function private.organisation_name_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user = 'app_fetcher' and (new.kind <> 'alias' or new.source <> 'job_site') then
    raise exception 'organisation_name guard: the fetcher writes only alias names from job_site' using errcode = 'P0001'; end if;
  return new;
end $$;
revoke all on function private.organisation_name_guard() from public, anon, authenticated, service_role;
create trigger organisation_name_guard before insert or update on organisation_name for each row execute function private.organisation_name_guard();

reset role;
