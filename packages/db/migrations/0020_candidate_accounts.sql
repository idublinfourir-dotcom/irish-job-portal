-- Step 9, part 10 (#227 D3, D5; #57): candidate accounts without a CV upload.
-- 1. A saved job, a tracker row or a "Did you apply?" click names only a job that was live at some time, and a candidate saves at most 200 jobs (D5).
--    "Never live" is a job still in draft or in_review, or one the fetcher closed as abandoned. A job removed before it went live also has the reason
--    'removed', which a live job removed later has too, so it cannot be told apart and is let through (ponytail: add a column if that ever matters).
--    The check runs with the owner's rights because the candidate role cannot read job.close_reason. Nothing is replaced: these are new objects.
-- 2. A candidate's notification preference names one of three categories, and the account category cannot be switched off (D3).
set role portal_owner;

create function private.candidate_job_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from job j where j.id = new.job_id
      and (j.status in ('live','under_review','hidden') or (j.status = 'closed' and j.close_reason is distinct from 'abandoned'))) then
    raise exception 'candidate job: the job was never live' using errcode = 'P0001'; end if;
  if tg_table_name = 'saved_job' then
    -- Over 100 saved, one save at a time per candidate, so two at once cannot both pass the count. Below that no lock is taken: a bulk load of many
    -- candidates in one transaction (the page-gate fill) would otherwise hold one advisory lock per candidate, and one login cannot send 100 saves at once.
    if (select count(*) from saved_job where candidate_user_id = new.candidate_user_id) >= 100 then
      perform pg_advisory_xact_lock(hashtextextended('saved_job:' || new.candidate_user_id, 0));
      if (select count(*) from saved_job where candidate_user_id = new.candidate_user_id) >= 200 then
        raise exception 'candidate job: saved jobs full (200)' using errcode = 'P0001'; end if;
    end if;
  end if;
  return new;
end $$;
create trigger saved_job_check before insert on saved_job for each row execute function private.candidate_job_check();
create trigger tracker_entry_job_check before insert or update of job_id on tracker_entry for each row execute function private.candidate_job_check();
create trigger apply_click_job_check before insert or update of job_id on apply_click for each row execute function private.candidate_job_check();

alter table notification_preference add constraint notification_preference_candidate_category check (
  candidate_user_id is null or (category in ('job_alerts','apply_reminders','account') and (category <> 'account' or enabled)));

reset role;
