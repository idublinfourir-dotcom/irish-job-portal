-- Step 15, audit row N5: the portal notices the database functions still did not write. Each writes one `notification` (category 'account') and one
-- pending `email_outbox` row per person, in the same transaction as the event, ids only in params (placeholder wording, N2):
--   1. private.team_remove (copied from 0013): the removed member, template team_removed, when an active member is removed (not a withdrawn invite;
--      a member who leaves by themselves goes through team_leave, which writes nothing).
--   2. private.team_transfer (copied from 0013): the new owner, template owner_transferred. The old owner made the change, so gets nothing (as a self-leave).
--   3. private.owner_reassign_complete (copied from 0022): the new owner (owner_transferred) and the old owner (owner_reassign_done). The old owner's
--      advance email at the request (owner_reassign_notice, 0022) stays as it is.
-- The pay floor, report and rules-run notices are written by the TypeScript statements (pay-floors.ts, trust-safety.ts, rules-run-cli.ts); no migration.
set role portal_owner;

create or replace function private.team_remove(p_user text, p_membership bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; v_status text; v_member text;
begin
  m := private.team_owner(p_user);
  select status, portal_user_id into v_status, v_member from membership
   where id = p_membership and organisation_id = m.organisation_id and status in ('active','invited') and id <> m.id;
  if v_status is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  update membership set status = 'removed', removed_at = now(), invited_email = null, invite_token_hash = null where id = p_membership;
  perform private.team_audit(p_user, 'membership.remove', p_membership, jsonb_build_object('status', v_status), jsonb_build_object('status', 'removed'));
  if v_status = 'active' then
    insert into notification(portal_user_id, organisation_id, category, template_key, params)
      values (v_member, m.organisation_id, 'account', 'team_removed', jsonb_build_object('organisationId', m.organisation_id));
    insert into email_outbox(template, portal_user_id, params) values ('team_removed', v_member, jsonb_build_object('organisationId', m.organisation_id));
  end if;
  return jsonb_build_object('membershipId', p_membership);
end $$;

create or replace function private.team_transfer(p_user text, p_membership bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; r membership;
begin
  m := private.team_owner(p_user);
  select * into r from membership where id = p_membership and organisation_id = m.organisation_id and status = 'active' and id <> m.id;
  if r.id is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from portal_user where id = r.portal_user_id and status = 'active' and deleted_at is null) then
    raise exception 'team refused: REFUSED new owner blocked or deleted' using errcode = 'P0001'; end if;
  update membership set role = 'recruiter' where id = m.id;
  update membership set role = 'account_owner' where id = r.id;
  perform private.team_audit(p_user, 'membership.transfer', r.id, jsonb_build_object('role', r.role, 'old_owner_membership', m.id), jsonb_build_object('role', 'account_owner', 'old_owner_role', 'recruiter'));
  insert into notification(portal_user_id, organisation_id, category, template_key, params)
    values (r.portal_user_id, m.organisation_id, 'account', 'owner_transferred', jsonb_build_object('organisationId', m.organisation_id));
  insert into email_outbox(template, portal_user_id, params) values ('owner_transferred', r.portal_user_id, jsonb_build_object('organisationId', m.organisation_id));
  return jsonb_build_object('membershipId', r.id);
end $$;

create or replace function private.owner_reassign_complete(p_staff text, p_request bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r owner_reassign; o organisation; n membership; old membership;
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer'], 'NOT_ACCOUNT_REVIEWER');
  select * into r from owner_reassign where id = p_request;
  if r.id is null then raise exception 'owner reassign refused: NOT_FOUND' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = r.organisation_id for no key update;
  select * into r from owner_reassign where id = p_request for update;
  if r.status <> 'open' then raise exception 'owner reassign refused: NOT_OPEN' using errcode = 'P0001'; end if;
  if now() < r.completes_after then raise exception 'owner reassign refused: TOO_EARLY the 7 days have not passed' using errcode = 'P0001'; end if;
  select * into o from organisation where id = r.organisation_id;
  if o.merged_into_id is not null or not private.team_open(o.status) then raise exception 'owner reassign refused: COMPANY_NOT_OPEN' using errcode = 'P0001'; end if;
  select * into old from membership where id = r.old_owner_membership_id;
  if old.status <> 'active' or old.role <> 'account_owner' then raise exception 'owner reassign refused: OWNER_CHANGED' using errcode = 'P0001'; end if;
  select * into n from membership where id = r.new_owner_membership_id;
  if n.status <> 'active' then raise exception 'owner reassign refused: MEMBER_GONE' using errcode = 'P0001'; end if;
  if not exists (select 1 from portal_user where id = n.portal_user_id and status = 'active' and deleted_at is null) then
    raise exception 'owner reassign refused: USER_NOT_ACTIVE' using errcode = 'P0001'; end if;
  update membership set role = 'recruiter' where id = old.id; -- demote, then promote, in one transaction (one_owner_per_org)
  update membership set role = 'account_owner' where id = n.id;
  update owner_reassign set status = 'done', decided_by_staff_user_id = p_staff, decided_at = now() where id = r.id;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, before, after, source)
    values ('admin_action', p_staff, 'owner_reassign.complete', 'organisation', o.id::text,
            jsonb_build_object('request_id', r.id, 'owner_membership', old.id, 'new_owner_role', n.role),
            jsonb_build_object('owner_membership', n.id, 'old_owner_role', 'recruiter'), 'panel');
  insert into notification(portal_user_id, organisation_id, category, template_key, params)
    values (n.portal_user_id, o.id, 'account', 'owner_transferred', jsonb_build_object('organisationId', o.id, 'requestId', r.id)),
           (old.portal_user_id, o.id, 'account', 'owner_reassign_done', jsonb_build_object('organisationId', o.id, 'requestId', r.id));
  insert into email_outbox(template, portal_user_id, params)
    values ('owner_transferred', n.portal_user_id, jsonb_build_object('organisationId', o.id, 'requestId', r.id)),
           ('owner_reassign_done', old.portal_user_id, jsonb_build_object('organisationId', o.id, 'requestId', r.id));
  return jsonb_build_object('requestId', r.id, 'organisationId', o.id, 'ownerMembershipId', n.id);
end $$;

reset role;
