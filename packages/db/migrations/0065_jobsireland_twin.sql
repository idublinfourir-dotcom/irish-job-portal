-- The cross-source twin of a JobsIreland job (D1 wave 1, step15/d1w1-A-brief.md). JobsIreland repeats jobs the employer also publishes on its own
-- hiring system (Dawn Meats on iCIMS, for example), so the JobsIreland copy is hidden, one to one in the spirit of #281 and 0057:
--   1. A live fetched job of the `jobsireland` kind is hidden as 'duplicate' only when exactly one live job of its organisation from another source
--      (another job_source: another board, or the employer's own or a staff job; agency jobs never) has the same title_key and a county that agrees
--      (equal, or either empty, the 0057 rule), and that job holds no
--      twin yet. No organisation link, two or more matches, or a match that already holds a twin: nothing is hidden. Its twin_of_job_id is that job.
--   2. Both ways, as 0057: a JobsIreland job going live looks for its one match; a job of another source going live (or retitled while live) with no
--      twin hides the one live JobsIreland job of its organisation with its title_key, when that job then has exactly this one match.
--   3. The restore of 0057 now runs for a twin holder of any source (an iCIMS job closed by the fetcher, a staff close), not only an employer's job:
--      when the holder leaves live, its twin goes back to live when it may be live, else closes as 'closed'. Not when the holder itself was hidden
--      as a duplicate (an employer's job took it over): its JobsIreland twin then stays hidden under it, and comes back when the holder does and
--      later closes.
-- private.job_twin is copied from 0057_fetched_twin.sql (its only definition); the lines marked 0065 are new. The trigger is kept as it is.
set role portal_owner;

-- 0065: how many live jobs of an organisation have a title and a county that agrees (equal, or either empty, as 0057), from any source but `p_src`
-- (a fetched job of another board, an employer's own or a staff job; never an agency's), and the first. Two scans of the two partial indexes of 0057, so a company with many live jobs costs no more.
create function private.twin_matches(p_org bigint, p_key text, p_src bigint, p_county text) returns table(n bigint, first_id bigint) language sql stable as $$
  select count(*), min(id) from (
    (select e.id from public.job e where e.organisation_id = p_org and e.source = 'fetched' and e.status = 'live' and e.title_key = p_key and e.job_source_id is distinct from p_src
      and (e.county is null or p_county is null or e.county = p_county) limit 2)
    union all
    (select e.id from public.job e where e.organisation_id = p_org and e.source in ('employer','admin_manual') and e.status = 'live' and e.title_key = p_key
      and (e.county is null or p_county is null or e.county = p_county) limit 2)) m -- only "exactly one" matters: each side stops at 2
$$;

-- 0065: live fetched jobs by board, company and title, so a job of another source finds its JobsIreland twin by the JobsIreland board alone, at a
-- cost that does not grow with the company's other same-title jobs (a bulk insert of 20,000 same-title jobs was quadratic without it).
create index job_twin_board_idx on job(job_source_id, organisation_id, title_key) where source = 'fetched' and status = 'live';

create or replace function private.job_twin() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare pair_owner bigint; pair_twin bigint; ji boolean := false; n bigint; twin_src bigint; twin_county text; ji_src bigint[]; -- 0065: ji to ji_src
begin
  if tg_op = 'UPDATE' and row(new.status, new.title, new.county, new.own_page_url) is not distinct from row(old.status, old.title, old.county, old.own_page_url) then return null; end if;
  if new.source = 'fetched' then
    if new.status = 'live' then -- 0065: no early return, so the restore below also runs for a fetched holder
      ji_src := array(select s.id from job_source s where s.kind = 'jobsireland'); -- 0065: the JobsIreland boards (one)
      ji := new.job_source_id = any(ji_src);
      -- a live employer job of the organisation with no twin yet, whose link is this advert's, else whose only same-title fetched job this is
      select e.id into pair_owner from job e
       where e.organisation_id = new.organisation_id and e.status = 'live' and e.source in ('employer','admin_manual')
         and not exists (select 1 from job t where t.twin_of_job_id = e.id and t.hidden_reason = 'duplicate')
         and (private.twin_url(e.own_page_url) = private.twin_url(new.own_page_url)
           or (e.title_key = new.title_key and (e.county is null or new.county is null or e.county = new.county)
               and (select count(*) from job f where f.organisation_id = new.organisation_id and f.source = 'fetched' and f.status = 'live'
                      and f.title_key = e.title_key and (f.county is null or e.county is null or f.county = e.county)) = 1))
       order by private.twin_url(e.own_page_url) = private.twin_url(new.own_page_url) desc, e.id limit 1;
      -- 0065: a JobsIreland job: the only live job of another source of its organisation with its title, if that job holds no twin yet
      if pair_owner is null and ji then
        select m.first_id into pair_owner from private.twin_matches(new.organisation_id, new.title_key, new.job_source_id, new.county) m where m.n = 1;
        if exists (select 1 from job t where t.twin_of_job_id = pair_owner and t.hidden_reason = 'duplicate') then pair_owner := null; end if;
      end if;
      if pair_owner is not null then
        update job set status = 'hidden', hidden_reason = 'duplicate', twin_of_job_id = pair_owner where id = new.id and status = 'live';
        perform private.job_twin_saved(new.id, pair_owner);
      end if;
    end if;
  elsif new.source in ('employer','admin_manual') then -- 0065: elsif, so the JobsIreland and restore parts below run for these too
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
  end if;
  -- 0065: a live job of another source with no twin hides the one live JobsIreland job of its organisation with its title, when this is that job's only match
  if new.status = 'live' and pair_owner is null and not ji and new.source <> 'agency' and new.organisation_id is not null then -- pair_owner: this job was just hidden
    if ji_src is null then ji_src := array(select s.id from job_source s where s.kind = 'jobsireland'); end if;
    -- from each JobsIreland board (one) through job_twin_board_idx, at most 2 rows: none, or two, is no twin. No board: no query.
    n := 0;
    foreach twin_src in array ji_src loop
      select min(f.id), count(*), min(f.county) into pair_twin, n, twin_county from (
        select f.id, f.county from job f
         where f.job_source_id = twin_src and f.organisation_id = new.organisation_id and f.title_key = new.title_key and f.source = 'fetched' and f.status = 'live'
           and (f.county is null or new.county is null or f.county = new.county) limit 2) f;
      exit when n > 0;
    end loop;
    if n <> 1 then pair_twin := null;
    elsif (select m.n from private.twin_matches(new.organisation_id, new.title_key, twin_src, twin_county) m) <> 1 then pair_twin := null; end if;
    -- checked only on a hit (rare): a new row holds no twin, and one that already holds one takes no second
    if pair_twin is not null and not exists (select 1 from job t where t.twin_of_job_id = new.id and t.hidden_reason = 'duplicate') then
      update job set status = 'hidden', hidden_reason = 'duplicate', twin_of_job_id = new.id where id = pair_twin;
      perform private.job_twin_saved(pair_twin, new.id);
    end if;
  end if;
  if tg_op = 'UPDATE' and old.status = 'live' and new.status <> 'live'
    and new.hidden_reason is distinct from 'duplicate' -- 0065: a holder hidden as a duplicate keeps its twin hidden under it
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

reset role;
