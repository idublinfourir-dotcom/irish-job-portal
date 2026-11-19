-- Step 15 staff tools D (audit rows Q8, Q11; 19 Nov 2026). Tests: packages/db/test/staff-notices.test.ts.
--   1. Q8: the #74 target counts read aggregates of two candidate tables app_admin may not read. A column grant on the one column each count
--      needs (tracker_entry.origin, application.status), so the admin login still sees no candidate, job or note in them.
--   2. Q11: when a report arrives, each active trust_and_safety staff member gets one email row (template staff_report_new, placeholder wording, no
--      params). At most one per person per hour (the dedupe key names the hour): a burst of reports is one email, and the counts read and the daily
--      digest show the rest. Security definer: the reporter's login (app_candidate, app_portal) may neither read staff_role nor queue staff email.
set role portal_owner;

-- ===== 1. the target counts
grant select (origin) on tracker_entry to app_admin;
grant select (status) on application to app_admin;

-- ===== 2. the report alert
create function private.report_staff_alert() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into email_outbox(template, staff_user_id, dedupe_key) select 'staff_report_new', u.id, 'staff_report_new:' || u.id || ':' || to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24')
    from staff_user u where u.status = 'active' and exists (select 1 from staff_role r where r.staff_user_id = u.id and r.role = 'trust_and_safety')
    on conflict (dedupe_key) do nothing;
  return null;
end $$;
revoke all on function private.report_staff_alert() from public, anon, authenticated, service_role;
create trigger report_staff_alert after insert on report for each row execute function private.report_staff_alert();

reset role;
