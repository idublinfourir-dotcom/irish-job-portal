-- The fetched twin of an employer's own job (step 15 row D3, #53): when a job is both fetched and posted by its employer, only the employer's version is shown.
-- One to one (engineer's option A, 19 Nov 2026: one company often has several live fetched jobs with the same title, separate openings):
--   1. An employer or admin_manual job hides at most one fetched job of its own organisation, its twin. The pair is kept on the hidden job
--      (job.twin_of_job_id, unique while hidden as 'duplicate'), and the restore follows that link. Agency jobs are never twins.
--   2. The twin is (a) the live fetched job whose advert link (own_page_url) equals the employer job's own_page_url after trim, dropping a
--      #fragment and trailing slashes (no case change: paths are case sensitive), else (b) the only live fetched job of the organisation with the
--      same title words (title_key, the title part of nameTitlePlaceKey) and county (equal, or either empty). Several candidates and no link
--      match: nothing is hidden. Both ways the same: a fetched job that goes live (insert, reopen, staff release, edit) is hidden when it is the
--      link match, or the only same-title fetched job, of a live employer job that has no twin yet.
--   3. One AFTER trigger, so every CHECK and job_guard judge the row as written first and a twin trigger never masks an invalid row. The fetcher
--      never moves a hidden job (job_guard, plan.ts stateOf "held"): later fetches keep the twin hidden, and an advert gone meanwhile only marks the advert.
--   4. When the employer's job leaves live, its twin goes back to live when it may be live (advert not gone, search_vector and the
--      critical_skills_eligible badge present, organisation not closed), else it closes as 'closed' (a close the fetcher may undo when the advert
--      comes back). Every row the restore writes is valid, so it cannot fail the employer's statement. Skipped while the organisation is suspended
--      (its jobs are hidden under the suspension and come back with it, the employer's job included, which keeps the twin hidden) or banned (the
--      ban closes every job as removed). A closed organisation is not skipped: the owner's close (P12, 0031) closes the employer's jobs while the
--      company is still open, and the twin comes back live (the employer still advertises on the board).
--   5. Saved jobs: each candidate who saved the twin has the employer's job saved instead, the twin's row removed, in the same transaction.
-- The trigger runs as portal_owner (security definer), so job_guard's role rules do not apply to its own writes.
set role portal_owner;

alter table job drop constraint job_hidden_reason_check;
alter table job add constraint job_hidden_reason_check check (hidden_reason in ('report','organisation_suspended','admin','duplicate'));

-- The title key, stored, with one partial index per side (the gap round in the D3 report has the measurements).
alter table job add column title_key text generated always as (trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g'))) stored;
create index job_twin_owner_idx on job(organisation_id, title_key) where status = 'live' and source in ('employer','admin_manual');
create index job_twin_fetched_idx on job(organisation_id, title_key) where source = 'fetched' and status in ('live','hidden');

alter table job add column twin_of_job_id bigint references job(id) on delete set null;
create unique index job_twin_of_idx on job(twin_of_job_id) where hidden_reason = 'duplicate';

create function private.twin_url(u text) returns text language sql immutable as $$ select rtrim(split_part(btrim(u), '#', 1), '/') $$;

create function private.job_twin_saved(p_from bigint, p_to bigint) returns void language sql security definer set search_path = public, pg_temp as $$
  insert into saved_job(candidate_user_id, job_id) select candidate_user_id, p_to from saved_job where job_id = p_from on conflict do nothing;
  delete from saved_job where job_id = p_from;
$$;

create function private.job_twin() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_owner bigint; pair_twin bigint;
begin
  if tg_op = 'UPDATE' and row(new.status, new.title, new.county, new.own_page_url) is not distinct from row(old.status, old.title, old.county, old.own_page_url) then return null; end if;
  if new.source = 'fetched' then
    if new.status <> 'live' then return null; end if;
    -- a live employer job of the organisation with no twin yet, whose link is this advert's, else whose only same-title fetched job this is
    select e.id into pair_owner from job e
     where e.organisation_id = new.organisation_id and e.status = 'live' and e.source in ('employer','admin_manual')
       and not exists (select 1 from job t where t.twin_of_job_id = e.id and t.hidden_reason = 'duplicate')
       and (private.twin_url(e.own_page_url) = private.twin_url(new.own_page_url)
         or (e.title_key = new.title_key and (e.county is null or new.county is null or e.county = new.county)
             and (select count(*) from job f where f.organisation_id = new.organisation_id and f.source = 'fetched' and f.status = 'live'
                    and f.title_key = e.title_key and (f.county is null or e.county is null or f.county = e.county)) = 1))
     order by private.twin_url(e.own_page_url) = private.twin_url(new.own_page_url) desc, e.id limit 1;
    if pair_owner is not null then
      update job set status = 'hidden', hidden_reason = 'duplicate', twin_of_job_id = pair_owner where id = new.id and status = 'live';
      perform private.job_twin_saved(new.id, pair_owner);
    end if;
    return null;
  end if;
  if new.source not in ('employer','admin_manual') then return null; end if;
  if new.status = 'live' and not exists (select 1 from job t where t.twin_of_job_id = new.id and t.hidden_reason = 'duplicate') then
    select f.id into pair_twin from job f
     where f.organisation_id = new.organisation_id and f.source = 'fetched' and f.status = 'live'
       and private.twin_url(f.own_page_url) = private.twin_url(new.own_page_url) order by f.id limit 1;
    if pair_twin is null then
      select min(f.id) into pair_twin from job f
       where f.organisation_id = new.organisation_id and f.source = 'fetched' and f.status = 'live'
         and f.title_key = new.title_key and (f.county is null or new.county is null or f.county = new.county)
      having count(*) = 1;
    end if;
    if pair_twin is not null then
      update job set status = 'hidden', hidden_reason = 'duplicate', twin_of_job_id = new.id where id = pair_twin;
      perform private.job_twin_saved(pair_twin, new.id);
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'live' and new.status <> 'live'
    and not exists (select 1 from organisation o where o.id = old.organisation_id and o.status in ('suspended','banned')) then
    with t as (
      select f.id, (f.search_vector is not null and f.badge is not distinct from 'critical_skills_eligible'
               and not exists (select 1 from fetched_advert a where a.id = f.fetched_advert_id and a.gone_at is not null)
               and not exists (select 1 from organisation o where o.id = f.organisation_id and o.status = 'closed')) as ok
        from job f where f.twin_of_job_id = old.id and f.hidden_reason = 'duplicate' and f.status = 'hidden')
    update job f set status = case when t.ok then 'live' else 'closed' end, hidden_reason = null, twin_of_job_id = null,
           close_reason = case when t.ok then null else 'closed' end, search_vector = case when t.ok then f.search_vector end
      from t where f.id = t.id;
  end if;
  return null;
end $$;
create trigger job_twin after insert or update of status, title, county, own_page_url on job for each row execute function private.job_twin();

reset role;
