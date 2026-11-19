-- Decision #275 (19 Nov 2026): the email queue under Brevo's free 300 a day. Tests: packages/db/test/outbox.test.ts, alerts-run.test.ts, perf/outbox.perf.ts.
--   1. email_outbox_pending_idx now orders by (template = 'job_alert'), send_after, id: the outbox claim takes every other row (notices, data
--      request confirms, report alerts, digests) before job alerts, oldest first in each group, straight from the index.
--   2. private.alert_weekly_day(candidate id): a fixed ISO weekday 1 (Monday) to 7 from the md5 of the id, so weekly alerts spread over the week
--      (alerts-run-cli.ts weeklyDay is the same formula).
--   3. private.queue_job_alerts, replaced: a weekly alert is due on or after its day, at most once per UTC week (Monday 00:00). At the switch every
--      weekly alert was last sent on a Monday, so it is not due again that week and goes out on its own day the next week: each week exactly one
--      email, none missed or doubled. A run missed on the day is caught up later the same week. Daily alerts unchanged.
set role portal_owner;

drop index email_outbox_pending_idx;
create index email_outbox_pending_idx on email_outbox((template = 'job_alert'), send_after, id) where status = 'pending';

create function private.alert_weekly_day(p_id text) returns int language sql immutable parallel safe set search_path = pg_catalog as $$
  select 1 + ('x' || left(md5(p_id), 7))::bit(28)::int % 7
$$;
revoke all on function private.alert_weekly_day(text) from public, anon, authenticated, service_role;

create or replace function private.queue_job_alerts(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  day_start timestamptz := date_trunc('day', p_now, 'UTC');
  run_on text := to_char(p_now at time zone 'UTC', 'YYYY-MM-DD');
  week_start timestamptz := date_trunc('week', p_now, 'UTC');
  dow int := extract(isodow from p_now at time zone 'UTC');
  -- null when the setting is empty: then nobody is dormant (a comparison with null is never true)
  cutoff timestamptz := p_now - make_interval(days => (select value from setting where key = 'alert_dormant'));
  res jsonb;
begin
  with dormant as (
    update alert a set status = 'paused', pause_reason = 'dormant'
      from candidate_user u where u.id = a.candidate_user_id and a.status = 'active' and u.last_active_at < cutoff
    returning a.id
  ), due as (
    -- active alerts of verified, live, not dormant candidates whose job_alerts email switch is on (no row means on, as candidate.ts reads it).
    -- The dormant test is repeated here, not read from the CTE above: every CTE sees the same snapshot, so those alerts still look active.
    select a.id, a.candidate_user_id, a.occupation_code, a.sector, a.county, a.badge, a.salary_min, coalesce(a.last_sent_at, a.created_at) as since
      from alert a join candidate_user u on u.id = a.candidate_user_id
     where a.status = 'active' and (a.last_sent_at is null or a.last_sent_at < day_start)
       -- weekly (#275): on or after the candidate's own day, once per UTC week (Monday to Sunday)
       and (a.frequency = 'daily' or (dow >= private.alert_weekly_day(a.candidate_user_id) and (a.last_sent_at is null or a.last_sent_at < week_start)))
       and u.email_verified and u.deleted_at is null and u.suspended_at is null
       and not coalesce(u.last_active_at < cutoff, false)
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
                            'rows_written', (select count(*) from written), 'alerts_paused', (select count(*) from dormant))
    into res;
  insert into audit_event(kind, actor_system, action, after, source)
    values ('admin_action', 'queue_job_alerts by ' || session_user, 'job_alerts.run', res || jsonb_build_object('run_on', run_on), 'scheduled_job');
  return res;
end $$;

reset role;
