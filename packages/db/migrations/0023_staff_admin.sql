-- Step 13, part 13d (#231, #234 D2 and D8). Three things, none of them replaces an existing function:
--   1. A pay floor's role family is a four-digit occupation code (#231). The portal route also refuses a code on the Ineligible list.
--   2. D8: a pay floor withdrawn while it was still pending_check drops its open or claimed pay_floor_check item in the same statement
--      (a trigger; the employer withdraws as app_portal, which cannot write review_item, so the function runs with the owner's rights).
--   3. D2: the audit log viewer filters by action, newest first, so an index on (action, at, id) keeps a rare action from scanning the whole log.
-- The constraint is checked against the rows that exist: no company carries the big-company flag yet (#230), so no floor has been signed.
set role portal_owner;

alter table pay_floor add constraint pay_floor_role_family_check check (role_family ~ '^[0-9]{4}$');

create function private.pay_floor_withdrawn() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update review_item set status = 'dropped', outcome = 'withdrawn', decided_at = now()
   where queue = 'pay_floor_check' and pay_floor_id = new.id and status in ('open','claimed');
  return null;
end $$;
create trigger pay_floor_withdrawn after update of status on pay_floor for each row
  when (old.status = 'pending_check' and new.status = 'withdrawn') execute function private.pay_floor_withdrawn();

create index audit_event_action_idx on audit_event(action, at, id);

reset role;
