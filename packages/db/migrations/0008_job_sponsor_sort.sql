-- The sponsor sort of the job list (#154, #157): most DETE permits in the last 5 years first, newest first within the same count, jobs whose
-- employer has no confirmed DETE link last. A stored key on the job, like salary_sort, so the sort is one index walk and no list page joins
-- dete_permit_count. It is kept the way permit_history is: private.refresh_permit_history() sets it on the organisation, the trigger copies it
-- onto the employer's jobs that are not closed, and the insert trigger copies it onto a new job.
set role portal_owner;

-- -1: no confirmed DETE link. 0 or more: permits in the current and four earlier calendar years (UTC), the same window as permitsLast5Years.
alter table organisation add column sponsor_sort integer not null default -1 check (sponsor_sort >= -1);
alter table job add column sponsor_sort integer not null default -1 check (sponsor_sort >= -1);

-- The browse index for the new sort, built like job_live_newest and job_live_salary. The candidate role reads the key and sorts by it.
create index job_live_sponsor on job((not quota_full) desc, sponsor_sort desc, posted_at desc, id desc) include (quota_full, closes_at) where status = 'live';
grant select (sponsor_sort) on job to app_candidate;

-- A new job copies the organisation's key next to its label, whatever the inserting role sends.
create or replace function private.job_defaults() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare nid bigint;
begin
  if tg_op = 'INSERT' then
    select o.permit_history, o.sponsor_sort into new.permit_history, new.sponsor_sort from organisation o where o.id = new.organisation_id;
  end if;
  if new.permit_employer_kind = 'client' then
    select n.id into nid from organisation_name n
     where n.normalised_name = btrim(regexp_replace(lower(coalesce(new.permit_employer_name, '')), '[^a-z0-9]+', ' ', 'g')) order by (n.kind = 'legal') desc, n.id limit 1;
    new.permit_employer_name_id := nid;
    new.permit_employer_check := case when nid is null then 'not_found' else 'found' end;
  end if;
  return new;
end $$;

-- The label and the key are copied onto the organisation's jobs that are not closed when either changes.
create or replace function private.organisation_permit_history() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update job set permit_history = new.permit_history, sponsor_sort = new.sponsor_sort
   where organisation_id = new.id and status <> 'closed' and (permit_history, sponsor_sort) is distinct from (new.permit_history, new.sponsor_sort);
  return null;
end $$;
drop trigger organisation_permit_history on organisation;
create trigger organisation_permit_history after update of permit_history, sponsor_sort on organisation for each row execute function private.organisation_permit_history();

-- As in 0007, plus the key: -1 when no DETE row is linked to any of the employer's names, else the permits of the last 5 calendar years
-- (0 when it is linked but has none in that window). Changes only rows where the label or the key is wrong, and returns how many organisations changed.
create or replace function private.refresh_permit_history() returns integer language sql security definer set search_path = public, pg_temp as $$
  with y as (select extract(year from now() at time zone 'utc')::int as now_year),
  h as (
    select n.organisation_id as id, coalesce(bool_or(d.permits > 0 and d.year >= 2019), false) as has_history,
           coalesce(sum(d.permits) filter (where d.year between y.now_year - 4 and y.now_year), 0)::int as recent
      from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id cross join y
     where n.organisation_id is not null group by n.organisation_id),
  w as (
    select o.id, case when h.has_history then 'has_history' when o.permit_history = 'first_time' then 'first_time' else 'not_linked' end as label,
           coalesce(h.recent, -1) as sort
      from organisation o left join h on h.id = o.id),
  u as (
    update organisation o set permit_history = w.label, sponsor_sort = w.sort
     from w where w.id = o.id and (o.permit_history, o.sponsor_sort) is distinct from (w.label, w.sort) returning o.id)
  select count(*)::integer from u
$$;

-- A database that already holds DETE links gets its keys now, not at the next import.
select private.refresh_permit_history();

reset role;
