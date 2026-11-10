-- Four safeguards from the database review of 10 November 2026 (findings M1 to M4). Tests: packages/db/test/admin-fixes.test.ts.
set role portal_owner;

-- ===== M2: a change to a setting's value follows the two-person rule, is stamped and audited, and is never negative.
-- One admin session could set a retention period to 0 and the next run_retention erased live accounts.
alter table approval_request drop constraint approval_request_kind_check, add constraint approval_request_kind_check check (kind in ('threshold','critical_skills_list',
  'ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed',
  'grant_administrator','grant_role','terms_privacy_page','setting'));
alter table setting add constraint setting_value_check check (value is null or value >= 0); -- empty stays allowed: it means not set
-- Owner's rights (it marks the request used), for app_admin only (the trigger's WHEN reads the caller's current_user), so a migration is not blocked.
-- A new value needs a confirmed, unused 'setting' request for setting/key whose change names that value ({"value": 6}; empty is {"value": null}).
create function private.setting_guard() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare staff text := nullif(current_setting('app.staff_user_id', true), ''); rq bigint;
begin
  if staff is null or not exists (select 1 from staff_user u where u.id = staff and u.status = 'active') then
    raise exception 'setting: no acting staff member (set local app.staff_user_id to an active staff user)' using errcode = 'P0001'; end if;
  if tg_op = 'INSERT' or new.value is distinct from old.value then
    select id into rq from approval_request where kind = 'setting' and target_table = 'setting' and target_id = new.key and status = 'confirmed'
      and applied_at is null and change ? 'value' and change->>'value' is not distinct from new.value::text order by id limit 1;
    if rq is null then raise exception 'two-person rule: no confirmed setting request for setting/% with value %', new.key, coalesce(new.value::text, 'empty') using errcode = 'P0001'; end if;
    perform private.use_approval(rq, 'setting', 'setting', new.key); -- locks the row and refuses it if another write used it first
  end if;
  new.updated_by_staff_user_id := staff; new.updated_at := now();
  -- values only, no solicitor_note: the log holds no free text
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, before, after, second_staff_user_id, source)
    values ('admin_action', staff, 'setting.change', 'setting', new.key,
            case when tg_op = 'UPDATE' then to_jsonb(old) - 'key' - 'solicitor_note' - 'updated_by_staff_user_id' - 'updated_at' end,
            to_jsonb(new) - 'key' - 'solicitor_note' - 'updated_by_staff_user_id' - 'updated_at',
            (select confirmed_by_staff_user_id from approval_request where id = rq), 'panel');
  return new;
end $$;
create trigger setting_guard before insert or update on setting for each row when (current_user = 'app_admin') execute function private.setting_guard();
-- a unit never changes in the admin panel, and the trigger sets the stamps
revoke update on setting from app_admin;
grant update (value, is_guess, solicitor_confirmed_at, solicitor_note) on setting to app_admin;

-- ===== M1: app_admin cannot change the email of a staff login that holds a role (a reset link would then reach the person who changed it,
-- who could confirm their own request as that login). Same rule and shape as the reactivation guard it extends. Better Auth's own password and
-- session writes look the same as another staff member's to the database, so those paths are held by the Identity module.
create or replace function private.staff_user_no_reactivation() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if old.status = 'disabled' and new.status is distinct from old.status and current_user = 'app_admin'
     and exists (select 1 from staff_role r where r.staff_user_id = old.id) then
    raise exception 'staff_user: a disabled login is not turned back on by app_admin' using errcode = 'P0001'; end if;
  if new.email is distinct from old.email and current_user = 'app_admin' and exists (select 1 from staff_role r where r.staff_user_id = old.id) then
    raise exception 'staff_user: the email of a login that holds a role is not changed by app_admin; remove its roles first' using errcode = 'P0001'; end if;
  return new;
end $$;
drop trigger staff_user_no_reactivation on staff_user;
create trigger staff_user_no_reactivation before update of status, email on staff_user for each row execute function private.staff_user_no_reactivation();

-- ===== M3: each app role writes audit rows only about its own side, at now(). Invoker's rights, so current_user is the app role and the owner's
-- functions (erase_candidate, run_retention, the setting guard) pass untouched.
create function private.audit_event_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('app_candidate','app_portal','app_admin','app_fetcher') then return new; end if;
  new.at := now();
  if (case current_user
       when 'app_candidate' then num_nonnulls(new.actor_staff_user_id, new.actor_portal_user_id, new.actor_system) > 0 or new.kind = 'admin_action'
       when 'app_portal' then num_nonnulls(new.actor_staff_user_id, new.actor_candidate_user_id, new.actor_system) > 0 or new.kind = 'admin_action'
       when 'app_fetcher' then num_nonnulls(new.actor_staff_user_id, new.actor_candidate_user_id, new.actor_portal_user_id) > 0
       else num_nonnulls(new.actor_candidate_user_id, new.actor_portal_user_id) > 0 end) then
    raise exception 'audit_event: % cannot write a row with another side''s actor or kind', current_user using errcode = 'P0001'; end if;
  if new.actor_staff_user_id is distinct from nullif(current_setting('app.staff_user_id', true), '') and new.actor_staff_user_id is not null then
    raise exception 'audit_event: actor_staff_user_id must be the acting staff id' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger audit_event_guard before insert on audit_event for each row execute function private.audit_event_guard();

-- ===== M4: an app role queues email only to its own side, as a new pending row. The design has the fetcher send nothing, so it gets the candidate side
-- only (open question in the hand-over). Invoker's rights.
create function private.email_outbox_guard() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user not in ('app_candidate','app_portal','app_admin','app_fetcher') then return new; end if;
  if new.status is distinct from 'pending' or new.attempts is distinct from 0 or new.sent_at is not null then
    raise exception 'email_outbox: % queues a row only as pending, with attempts 0 and no sent_at', current_user using errcode = 'P0001'; end if;
  if (case current_user
       when 'app_portal' then num_nonnulls(new.candidate_user_id, new.staff_user_id, new.contact_message_id) > 0
       when 'app_admin' then false
       else num_nonnulls(new.portal_user_id, new.staff_user_id, new.membership_id, new.contact_message_id) > 0 end) then
    raise exception 'email_outbox: % queues email only to its own side', current_user using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger email_outbox_guard before insert on email_outbox for each row execute function private.email_outbox_guard();
-- A key an app role sends is stored as role:key, so `on conflict (dedupe_key) do nothing` still works inside one role and no role can take
-- another's key first. Rows written with the owner's rights keep their key. Fires for inserts through candidate_notification and portal_notification
-- too, where current_user is still the app role (tested).
create function private.dedupe_key_per_role() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user in ('app_candidate','app_portal','app_admin','app_fetcher') then new.dedupe_key := current_user || ':' || new.dedupe_key; end if;
  return new;
end $$;
create trigger email_outbox_dedupe_key before insert on email_outbox for each row execute function private.dedupe_key_per_role();
create trigger notification_dedupe_key before insert on notification for each row execute function private.dedupe_key_per_role();

reset role;
