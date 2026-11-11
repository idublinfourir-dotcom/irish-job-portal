-- The permit history label of an employer, set from the DETE data (#73, #150 to #154). The copy onto the employer's jobs that are
-- not closed is the existing trigger organisation_permit_history, so these functions only change organisation.permit_history.
set role portal_owner;

-- Recalculates every organisation's label and changes only the rows whose label is wrong (so the copy trigger fires only where needed).
-- has_history: some DETE row linked to any of its names has permits > 0 in 2019 or later. It always wins.
-- first_time: only an admin sets it (mark_first_time), and the recalculation keeps it unless such a row appears.
-- not_linked: everything else, an organisation that lost its links included. Returns how many labels changed.
create function private.refresh_permit_history() returns integer language sql security definer set search_path = public, pg_temp as $$
  with h as (
    select distinct n.organisation_id as id from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id
     where d.permits > 0 and d.year >= 2019 and n.organisation_id is not null),
  w as (
    select o.id, case when h.id is not null then 'has_history' when o.permit_history = 'first_time' then 'first_time' else 'not_linked' end as label
      from organisation o left join h on h.id = o.id),
  u as (
    update organisation o set permit_history = w.label from w where w.id = o.id and o.permit_history is distinct from w.label returning o.id)
  select count(*)::integer from u
$$;

-- "Checked DETE, no record found": allowed only while the organisation has no qualifying DETE row (the same test as above).
create function private.mark_first_time(p_organisation_id bigint) returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from organisation where id = p_organisation_id) then
    raise exception 'mark_first_time: no such organisation' using errcode = 'P0001'; end if;
  -- #73: first-time needs a confirmed employer, by the big-company list or a CRO number
  if not exists (select 1 from organisation where id = p_organisation_id and (is_big_company or cro_number is not null)) then
    raise exception 'mark_first_time: the employer is not confirmed (big-company list or CRO number)' using errcode = 'P0001'; end if;
  if exists (select 1 from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id
              where n.organisation_id = p_organisation_id and d.permits > 0 and d.year >= 2019) then
    raise exception 'mark_first_time: the organisation has a DETE permit record' using errcode = 'P0001'; end if;
  update organisation set permit_history = 'first_time' where id = p_organisation_id and permit_history <> 'first_time';
end $$;

revoke all on function private.refresh_permit_history(), private.mark_first_time(bigint) from public, anon, authenticated, service_role;
grant execute on function private.refresh_permit_history(), private.mark_first_time(bigint) to app_admin;

reset role;
