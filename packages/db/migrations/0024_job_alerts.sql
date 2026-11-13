-- Step 11, part 11b (#236 Q1, D2, D3): the daily job alert run. Nothing is replaced: these are new objects.
--   1. alert.created_at: when the alert was made, so a never-run alert's "new jobs" start there. Rows that exist get the migration time.
--   2. private.queue_job_alerts(p_now): finds the due alerts, matches them to the jobs that went live since the alert last ran, and writes one
--      email_outbox row per candidate (template job_alert, the shared shape in step11/wave-brief.md). Every due alert gets last_sent_at = p_now,
--      with or without new jobs, and the run writes one audit_event row with its counts. Run daily by packages/db/src/alerts-run-cli.ts.
-- D2, a job is sent once per alert: a job counts as new by job.posted_at, which the job trigger (newest copy in 0019_job_posting.sql) sets only on
-- the move into live from draft or in_review. A job that closes and reopens, or comes back from under_review or hidden, keeps its posted_at, so
-- it is never new again for an alert that already ran past it. No new column is needed.
set role portal_owner;

alter table alert add column created_at timestamptz not null default now();

create function private.queue_job_alerts(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  day_start timestamptz := date_trunc('day', p_now, 'UTC');
  run_on text := to_char(p_now at time zone 'UTC', 'YYYY-MM-DD');
  monday boolean := extract(isodow from p_now at time zone 'UTC') = 1;
  res jsonb;
begin
  with due as (
    -- active alerts of verified, live candidates whose job_alerts email switch is on (no row means on, as candidate.ts reads it)
    select a.id, a.candidate_user_id, a.occupation_code, a.sector, a.county, a.badge, a.salary_min, coalesce(a.last_sent_at, a.created_at) as since
      from alert a join candidate_user u on u.id = a.candidate_user_id
     where a.status = 'active' and (a.frequency = 'daily' or monday) and (a.last_sent_at is null or a.last_sent_at < day_start)
       and u.email_verified and u.deleted_at is null and u.suspended_at is null
       and not exists (select 1 from notification_preference p where p.candidate_user_id = a.candidate_user_id
                         and p.category = 'job_alerts' and p.channel = 'email' and not p.enabled)
  ), new_job as (
    -- read once (job_live_newest), not once per alert
    select j.id, j.posted_at, j.occupation_code, j.sector, j.county, j.badge, j.salary_sort, num_nonnulls(j.salary_low, j.salary_high) > 0 as has_pay
      from job j
     where j.status = 'live' and not j.quota_full and j.closes_at > p_now and j.posted_at <= p_now
       and j.posted_at > (select min(since) from due)
  ), hit as (
    select d.id as alert_id, d.candidate_user_id, j.id as job_id, j.posted_at,
           row_number() over (partition by d.id order by j.posted_at desc, j.id desc) as n
      from due d join new_job j on j.posted_at > d.since
       and (d.occupation_code is null or j.occupation_code = d.occupation_code)
       and (d.sector is null or j.sector = d.sector)
       and (d.county is null or j.county = d.county)
       and (d.salary_min is null or (j.has_pay and j.salary_sort >= d.salary_min))
       and (d.badge is null or j.badge = d.badge)
  ), per_alert as (
    select alert_id, candidate_user_id, jsonb_agg(job_id order by posted_at desc, job_id desc) as job_ids,
           row_number() over (partition by candidate_user_id order by alert_id) as k
      from hit where n <= 20 group by alert_id, candidate_user_id
  ), per_candidate as (
    select candidate_user_id, jsonb_agg(jsonb_build_object('alert_id', alert_id, 'job_ids', job_ids) order by alert_id) as alerts
      from per_alert where k <= 10 group by candidate_user_id
  ), written as (
    insert into email_outbox(template, candidate_user_id, params, dedupe_key, status, send_after)
    select 'job_alert', candidate_user_id, jsonb_build_object('run_on', run_on, 'alerts', alerts), 'job_alert:' || candidate_user_id || ':' || run_on, 'pending', p_now
      from per_candidate
    on conflict (dedupe_key) do nothing returning 1
  ), stamped as (
    update alert set last_sent_at = p_now where id in (select id from due) returning 1
  )
  select jsonb_build_object('alerts_due', (select count(*) from stamped), 'candidates_queued', (select count(*) from per_candidate),
                            'rows_written', (select count(*) from written))
    into res;
  insert into audit_event(kind, actor_system, action, after, source)
    values ('admin_action', 'queue_job_alerts by ' || session_user, 'job_alerts.run', res || jsonb_build_object('run_on', run_on), 'scheduled_job');
  return res;
end $$;

revoke all on function private.queue_job_alerts(timestamptz) from public, anon, authenticated, service_role;
grant execute on function private.queue_job_alerts(timestamptz) to app_admin;

reset role;
