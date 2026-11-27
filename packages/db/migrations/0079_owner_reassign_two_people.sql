-- Audit SEC-11 (27 Nov 2026): one account reviewer could both request and complete an owner change after its 7 days. private.owner_reassign_complete
-- (copied from 0036, the one change marked) now refuses the reviewer who asked with SAME_PERSON, so the change takes two people. Any other account
-- reviewer completes it as before; cancel is unchanged (anyone may stop a change). No grant changes: create or replace keeps app_admin's execute.
-- Works with the code before it: the wrappers map any "owner reassign refused: CODE" to its code (merges.ts companyRefusal), same_person is already 409.
set role portal_owner;

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
  if r.requested_by_staff_user_id = p_staff then -- SEC-11, the one change from 0036
    raise exception 'owner reassign refused: SAME_PERSON the reviewer who asked cannot complete it' using errcode = 'P0001'; end if;
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
