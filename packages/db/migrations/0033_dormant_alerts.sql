-- Step 15, audit row C2: job alerts pause while a candidate is dormant, and come back on the next sign-in.
--   1. setting alert_dormant (90 days, a guess): a candidate whose last_active_at (default now() at sign-up, 0001) is older than that counts as dormant for alerts.
--      As in the retention rules, a null last_active_at is never dormant. An empty value means alerts never pause for dormancy. The 12-month retention warning (inactive_profile, 0002) is a separate rule and unchanged.
--   2. private.queue_job_alerts, replaced: in the same one statement it pauses every active alert of a dormant candidate (status paused,
--      pause_reason dormant, last_sent_at untouched) and leaves those alerts out of the due set. Returns alerts_paused too.
--   3. private.alert_resume_dormant: after a sign-in or session refresh moves last_active_at (C1, packages/auth/src/index.ts), alerts paused for
--      dormant go back to active with last_sent_at = now(), so "new" starts again then (as the resume route, D6). Other pauses stay.
--   4. private.alert_dormant_guard: no app role writes pause_reason = 'dormant'; only the run (security definer, as portal_owner) does.
set role portal_owner;

insert into setting(key, value, unit, is_guess) values ('alert_dormant', 90, 'days', true);

create or replace function private.queue_job_alerts(p_now timestamptz default now()) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  day_start timestamptz := date_trunc('day', p_now, 'UTC');
  run_on text := to_char(p_now at time zone 'UTC', 'YYYY-MM-DD');
  monday boolean := extract(isodow from p_now at time zone 'UTC') = 1;
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
     where a.status = 'active' and (a.frequency = 'daily' or monday) and (a.last_sent_at is null or a.last_sent_at < day_start)
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

-- The candidate's own row only (new.id); a deleted candidate's alerts stay as they are.
create function private.alert_resume_dormant() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update alert set status = 'active', pause_reason = null, last_sent_at = now()
   where candidate_user_id = new.id and status = 'paused' and pause_reason = 'dormant';
  return null;
end $$;
create trigger candidate_user_resume_alerts after update of last_active_at on candidate_user for each row
  when (new.last_active_at is distinct from old.last_active_at and new.deleted_at is null) execute function private.alert_resume_dormant();

-- A pause_reason already 'dormant' may stay (the pause route keeps a paused alert's reason); a new 'dormant' from an app role is refused.
create function private.alert_dormant_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.pause_reason = 'dormant' and (tg_op = 'INSERT' or old.pause_reason is distinct from 'dormant') then
    raise exception 'alert guard: only the alert run pauses an alert for dormancy' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger alert_dormant_guard before insert or update of pause_reason on alert for each row
  when (current_user in ('app_candidate', 'app_portal', 'app_admin', 'app_fetcher')) execute function private.alert_dormant_guard();

revoke all on function private.alert_resume_dormant() from public, anon, authenticated, service_role;
revoke all on function private.alert_dormant_guard() from public, anon, authenticated, service_role;

reset role;
