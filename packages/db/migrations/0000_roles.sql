-- Roles, schemas and the extensions grant (design 23, section 2).
-- Runs as the migrating user (Supabase's postgres). It sets no passwords: on a real host the named
-- person sets them by hand, and the tests set their own.

-- Roles belong to the whole server, so create each one only if it is missing.
do $$
declare r text;
begin
  foreach r in array array['portal_owner', 'app_candidate', 'app_portal', 'app_admin', 'app_fetcher'] loop
    if not exists (select from pg_roles where rolname = r) then
      execute format('create role %I login', r);
    end if;
  end loop;
end
$$;

-- Lets the migrating user run later migrations as portal_owner (set role portal_owner; ... reset role;).
grant portal_owner to current_user with set true;

-- Section 2.2: a statement, a lock wait or an idle transaction cannot hold the database up for long.
alter role app_candidate set statement_timeout = '5s';
alter role app_candidate set lock_timeout = '3s';
alter role app_candidate set idle_in_transaction_session_timeout = '10s';
alter role app_portal set statement_timeout = '5s';
alter role app_portal set lock_timeout = '3s';
alter role app_portal set idle_in_transaction_session_timeout = '10s';
alter role app_fetcher set statement_timeout = '30s';
alter role app_fetcher set lock_timeout = '5s';
alter role app_fetcher set idle_in_transaction_session_timeout = '30s';
alter role app_admin set statement_timeout = '60s';
alter role app_admin set lock_timeout = '10s';
alter role app_admin set idle_in_transaction_session_timeout = '60s';

-- Tables and views live in public, functions in private, all owned by portal_owner.
-- Nobody else gets rights on private: anon and authenticated get no usage on it, and the app roles
-- that call functions are given usage later, one by one.
grant all on schema public to portal_owner;
grant usage on schema public to app_candidate, app_portal, app_admin, app_fetcher;
create schema if not exists private authorization portal_owner;

-- Extensions live in the extensions schema (Supabase's default), never in public. pg_graphql is on by
-- default in Supabase and nothing here uses GraphQL (Supabase lint 0026).
drop extension if exists pg_graphql;
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
-- Only the owner and the app roles use it: the owner builds the trigram indexes, the apps use the operators.
grant usage on schema extensions to portal_owner, app_candidate, app_portal, app_admin, app_fetcher;
