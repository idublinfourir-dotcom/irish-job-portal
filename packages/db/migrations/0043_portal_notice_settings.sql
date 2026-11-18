-- Step 15, audit row N7: a portal login's own notice settings. The routes (GET and PUT /api/portal/notices/settings, packages/db/src/notices.ts) write
-- through the portal_notification_preference view (grants 0003). The one switch is the job expiry reminder (category job_expiry_reminder, channel email);
-- the account category (owner transfer, removal and the other security notices) is never read by any sender, so it cannot be switched off.
-- private.expire_employer_jobs (copied from 0019) now skips the reminder when the person it goes to (the poster, else the owner) has switched it off.
set role portal_owner;

create or replace function private.expire_employer_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare closed integer; reminded integer;
begin
  with c as (
    update job set status = 'closed', closed_at = now(), close_reason = case when status = 'under_review' then 'under_review_expired' else 'expired' end
     where source in ('employer','agency') and status in ('live','in_review','under_review') and closes_at <= now() returning 1)
  select count(*) into closed from c;
  with r as (
    insert into email_outbox(template, portal_user_id, params, dedupe_key)
    select 'job_expiry_reminder', u.id, jsonb_build_object('jobId', j.id, 'closesAt', j.closes_at), 'job_expiry_reminder:' || j.id || ':' || extract(epoch from j.closes_at)::bigint
      from job j cross join lateral (
        select coalesce(
          (select p.portal_user_id from membership p where p.id = j.posted_by_membership_id and p.status = 'active'),
          (select o.portal_user_id from membership o where o.organisation_id = j.organisation_id and o.role = 'account_owner' and o.status = 'active')) as id) u
     where j.source in ('employer','agency') and j.status = 'live' and j.closes_at > now() and j.closes_at <= now() + interval '3 days' and u.id is not null
       and not exists (select 1 from notification_preference f where f.portal_user_id = u.id and f.category = 'job_expiry_reminder' and f.channel = 'email' and not f.enabled)
    on conflict (dedupe_key) do nothing returning 1)
  select count(*) into reminded from r;
  return jsonb_build_object('closed', closed, 'reminded', reminded);
end $$;

reset role;
