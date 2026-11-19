-- The fetched twin of an employer's own job (step 15 row D3, #53): when a job is both fetched and posted by its employer, only the employer's version is shown.
--   1. Twin: a fetched job and an employer or admin_manual job of the same organisation, the same title as lower-case words (the title part of
--      nameTitlePlaceKey in packages/rules/src/employers/duplicate-key.ts) and the same county, or either county empty. Agency jobs are not twins
--      (the agency is not the employer).
--   2. hidden_reason gains 'duplicate'. A live fetched twin is hidden with it when the employer's job goes live (or its title or county changes), and a
--      fetched job that would go live while its employer's twin is live (fetcher insert, reopen, staff release) is hidden instead. The fetcher never
--      moves a hidden job (job_guard, plan.ts stateOf "held"), so later fetches keep it hidden.
--   3. When the employer's job leaves live (or no longer matches), each of its 'duplicate' twins goes back to live if its advert is still fetched
--      (gone_at null), else it closes as 'closed' (a close the fetcher may undo when the advert comes back). Another live employer twin hides it
--      again on the way (trigger 1 runs on that update). Nothing changes while the organisation is suspended, banned or closed.
--   4. Saved jobs: each candidate who saved a twin being hidden has the employer's job saved instead, the twin's row removed, in the same transaction.
-- Both triggers run as portal_owner (security definer), so job_guard's role rules do not apply to their own writes.
set role portal_owner;

alter table job drop constraint job_hidden_reason_check;
alter table job add constraint job_hidden_reason_check check (hidden_reason in ('report','organisation_suspended','admin','duplicate'));

-- The twin lookup: organisation and title words, on live and hidden jobs only.
create index job_twin_idx on job(organisation_id, (trim(regexp_replace(lower(title), '[^a-z0-9]+', ' ', 'g')))) where status in ('live','hidden');

-- 1. Before: a fetched job going live while its employer's twin is live is hidden instead. Named so it runs after job_guard (triggers run by name).
create function private.job_twin_fetched() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.source = 'fetched' and new.status = 'live' and (tg_op = 'INSERT' or old.status <> 'live' or row(new.title, new.county) is distinct from row(old.title, old.county))
    and exists (select 1 from job e where e.organisation_id = new.organisation_id and e.status = 'live' and e.source in ('employer','admin_manual')
      and trim(regexp_replace(lower(e.title), '[^a-z0-9]+', ' ', 'g')) = trim(regexp_replace(lower(new.title), '[^a-z0-9]+', ' ', 'g'))
      and (e.county is null or new.county is null or e.county = new.county)) then
    new.status := 'hidden';
    new.hidden_reason := 'duplicate';
  end if;
  return new;
end $$;
create trigger job_twin_fetched before insert or update of status, title, county on job for each row execute function private.job_twin_fetched();

-- 2 and 3. After: the employer's job going live hides its fetched twins and moves their saved rows; leaving live lets them back.
create function private.job_twin_owner() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare twins bigint[];
begin
  if new.source not in ('employer','admin_manual') then return null; end if;
  if new.status = 'live' then
    with h as (update job f set status = 'hidden', hidden_reason = 'duplicate'
       where f.organisation_id = new.organisation_id and f.source = 'fetched' and f.status = 'live'
         and trim(regexp_replace(lower(f.title), '[^a-z0-9]+', ' ', 'g')) = trim(regexp_replace(lower(new.title), '[^a-z0-9]+', ' ', 'g'))
         and (f.county is null or new.county is null or f.county = new.county) returning f.id)
    select array_agg(id) into twins from h;
    if twins is not null then
      insert into saved_job(candidate_user_id, job_id) select candidate_user_id, new.id from saved_job where job_id = any(twins) on conflict do nothing;
      delete from saved_job where job_id = any(twins);
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'live' and (new.status <> 'live' or row(new.title, new.county) is distinct from row(old.title, old.county))
    and not exists (select 1 from organisation o where o.id = old.organisation_id and o.status in ('suspended','banned','closed')) then
    update job f set status = case when a.gone_at is null then 'live' else 'closed' end, hidden_reason = null,
           close_reason = case when a.gone_at is null then null else 'closed' end,
           search_vector = case when a.gone_at is null then f.search_vector end
      from fetched_advert a
     where a.id = f.fetched_advert_id and f.organisation_id = old.organisation_id and f.source = 'fetched' and f.status = 'hidden' and f.hidden_reason = 'duplicate'
       and trim(regexp_replace(lower(f.title), '[^a-z0-9]+', ' ', 'g')) = trim(regexp_replace(lower(old.title), '[^a-z0-9]+', ' ', 'g'))
       and (f.county is null or old.county is null or f.county = old.county)
       and not (new.status = 'live' and trim(regexp_replace(lower(f.title), '[^a-z0-9]+', ' ', 'g')) = trim(regexp_replace(lower(new.title), '[^a-z0-9]+', ' ', 'g'))
                and (f.county is null or new.county is null or f.county = new.county));
  end if;
  return null;
end $$;
create trigger job_twin_owner after insert or update of status, title, county on job for each row execute function private.job_twin_owner();

reset role;
