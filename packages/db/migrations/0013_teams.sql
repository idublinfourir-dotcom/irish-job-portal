-- Teams for employers and agencies (#52, #103, #130, #132, #184, #191): invite, accept, join request with the owner's answer, remove,
-- leave, role and signer change, and owner transfer. Since 0009 the portal login only reads membership, so these security definer
-- functions are its only way to change a team. Each takes the acting login's id (the route reads it from the session, never the body),
-- checks that login and its own membership in the same transaction, and writes one audit_event row of codes only (#182).
-- A refusal raises 'team refused: CODE ...'; the route turns CODE into its reply.
--
-- Every function that changes a team locks the organisation row first (for no key update, so job and membership inserts that point to
-- it are not held up), then re-reads the rows it checks. Two changes to one team therefore run one after the other: two transfers, two
-- accepts of one invite, an invite while the team fills up. accept and request also lock the login's own row, so one login's two calls
-- run one after the other too.
--
-- The invite token: the route makes 32 random bytes, puts them in the email link and gives the function only their sha256 (hex). The raw
-- token is never stored. An invite lasts 7 days.
set role portal_owner;

-- The acting login's active account owner membership, after locking its organisation.
create function private.team_owner(p_user text) returns membership
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; m membership;
begin
  select * into u from portal_user where id = p_user;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'team refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  select * into m from membership where portal_user_id = p_user and status = 'active';
  if m.id is null then raise exception 'team refused: NOT_OWNER no active membership' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = m.organisation_id for no key update;
  select * into m from membership where id = m.id; -- read again after the lock: a change that just committed counts
  if m.status <> 'active' then raise exception 'team refused: NOT_OWNER membership ended' using errcode = 'P0001'; end if;
  if m.role <> 'account_owner' then raise exception 'team refused: NOT_OWNER only the account owner manages the team' using errcode = 'P0001'; end if;
  return m;
end $$;

-- Room for one more on the team: drops the organisation's expired invites, then counts members, live invites and join requests.
-- ponytail: the limit is organisation.member_limit, 10 for every company (#103 guess). No admin screen raises it yet; until one exists the
-- named person sets the column as app_admin.
create function private.team_room(p_org bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update membership set status = 'removed', removed_at = now(), invited_email = null, invite_token_hash = null
   where organisation_id = p_org and status = 'invited' and invite_expires_at <= now();
  if (select count(*) from membership where organisation_id = p_org and status in ('invited','join_requested','awaiting_approval','active'))
     >= (select member_limit from organisation where id = p_org) then
    raise exception 'team refused: TEAM_FULL' using errcode = 'P0001'; end if;
end $$;

create function private.team_audit(p_user text, p_action text, p_membership bigint, p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, before, after, source)
    values ('security', p_user, p_action, 'membership', p_membership::text, p_before, p_after, 'site');
$$;

-- Companies that can take on people: claimed and not stopped (suspended, rejected, banned and closed cannot).
create function private.team_open(p_status text) returns boolean language sql immutable set search_path = public, pg_temp as $$
  select p_status in ('pending_review','needs_info','verified','verified_restricted');
$$;

-- The owner invites a colleague by email, as viewer, poster or recruiter, with the signer switch.
create function private.team_invite(p_user text, p_email text, p_role text, p_signer boolean, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; v_email text := lower(btrim(p_email)); v_id bigint; v_exp timestamptz := now() + interval '7 days';
begin
  m := private.team_owner(p_user);
  if not private.team_open((select status from organisation where id = m.organisation_id)) then
    raise exception 'team refused: ORGANISATION_NOT_AVAILABLE company cannot take on people' using errcode = 'P0001'; end if;
  if p_role is null or p_role not in ('viewer','poster','recruiter') then raise exception 'team refused: BAD_REQUEST role' using errcode = 'P0001'; end if;
  if p_role = 'viewer' and p_signer then raise exception 'team refused: VIEWER_NOT_SIGNER' using errcode = 'P0001'; end if;
  if v_email is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then raise exception 'team refused: BAD_REQUEST email' using errcode = 'P0001'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'team refused: BAD_REQUEST token hash' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_domain = split_part(v_email, '@', 2)) then raise exception 'team refused: REFUSED banned email domain' using errcode = 'P0001'; end if;
  if exists (select 1 from membership x join portal_user pu on pu.id = x.portal_user_id
             where x.organisation_id = m.organisation_id and x.status <> 'removed' and lower(pu.email) = v_email) then
    raise exception 'team refused: ALREADY_IN_TEAM a member or a join request has this email' using errcode = 'P0001'; end if;
  perform private.team_room(m.organisation_id);
  -- membership_org_invite_unique refuses a second live invite for the same email (the route answers ALREADY_IN_TEAM)
  insert into membership(organisation_id, invited_email, invited_by_membership_id, invite_token_hash, invite_expires_at, role, is_signer, status)
    values (m.organisation_id, v_email, m.id, p_token_hash, v_exp, p_role, p_signer, 'invited') returning id into v_id;
  perform private.team_audit(p_user, 'membership.invite', v_id, null, jsonb_build_object('role', p_role, 'is_signer', p_signer, 'status', 'invited'));
  return jsonb_build_object('membershipId', v_id, 'expiresAt', v_exp);
end $$;

-- The invited person, signed in with the invited email (confirmed), accepts. Their own pending join requests elsewhere are dropped.
create function private.team_accept(p_user text, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; i membership; v_org bigint;
begin
  select * into u from portal_user where id = p_user for no key update;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'team refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'team refused: EMAIL_NOT_VERIFIED' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_domain = lower(split_part(u.email, '@', 2))) then raise exception 'team refused: REFUSED banned email domain' using errcode = 'P0001'; end if;
  select organisation_id into v_org from membership where invite_token_hash = p_token_hash and status = 'invited';
  if v_org is null then raise exception 'team refused: INVITE_NOT_VALID no such invite' using errcode = 'P0001'; end if;
  if not private.team_open((select status from organisation where id = v_org for no key update)) then
    raise exception 'team refused: ORGANISATION_NOT_AVAILABLE company cannot take on people' using errcode = 'P0001'; end if;
  select * into i from membership where invite_token_hash = p_token_hash and status = 'invited'; -- again, after the lock
  if i.id is null then raise exception 'team refused: INVITE_NOT_VALID already used' using errcode = 'P0001'; end if;
  if i.invite_expires_at <= now() then raise exception 'team refused: INVITE_NOT_VALID expired' using errcode = 'P0001'; end if;
  if lower(i.invited_email) <> lower(u.email) then raise exception 'team refused: INVITE_NOT_VALID another email' using errcode = 'P0001'; end if;
  update membership set status = 'removed', removed_at = now() where portal_user_id = p_user and status = 'join_requested';
  -- one_company_per_login refuses a login that is already active in a company (#130)
  update membership set status = 'active', portal_user_id = p_user, joined_at = now(), invited_email = null, invite_token_hash = null where id = i.id;
  perform private.team_audit(p_user, 'membership.accept', i.id, jsonb_build_object('status', 'invited'), jsonb_build_object('status', 'active', 'role', i.role, 'is_signer', i.is_signer));
  return jsonb_build_object('organisationId', i.organisation_id, 'membershipId', i.id);
end $$;

-- A confirmed login with no company asks to join a claimed company. Its email domain must be one of the company's own domains
-- (organisation_domain, never a free provider), so a stranger cannot fill a team with requests. It joins as a viewer when approved.
create function private.team_request(p_user text, p_org bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; v_domain text; v_id bigint;
begin
  select * into u from portal_user where id = p_user for no key update;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'team refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  if not u.email_verified then raise exception 'team refused: EMAIL_NOT_VERIFIED' using errcode = 'P0001'; end if;
  v_domain := lower(split_part(u.email, '@', 2));
  if exists (select 1 from ban where email_domain = v_domain) then raise exception 'team refused: REFUSED banned email domain' using errcode = 'P0001'; end if;
  if not coalesce(private.team_open((select status from organisation where id = p_org for no key update)), false) then
    raise exception 'team refused: ORGANISATION_NOT_AVAILABLE not a claimed company that can take on people' using errcode = 'P0001'; end if;
  if exists (select 1 from membership where portal_user_id = p_user and status in ('active','join_requested','awaiting_approval')) then
    raise exception 'team refused: ALREADY_IN_A_COMPANY a member or a request elsewhere' using errcode = 'P0001'; end if;
  if not exists (select 1 from organisation_domain where organisation_id = p_org and domain = v_domain) then
    raise exception 'team refused: NOT_ALLOWED_DOMAIN email is not on the company''s domain' using errcode = 'P0001'; end if;
  perform private.team_room(p_org);
  insert into membership(organisation_id, portal_user_id, role, is_signer, status) values (p_org, p_user, 'viewer', false, 'join_requested') returning id into v_id;
  perform private.team_audit(p_user, 'membership.request', v_id, null, jsonb_build_object('status', 'join_requested'));
  return jsonb_build_object('membershipId', v_id);
end $$;

-- The owner approves (active, as viewer) or refuses (removed) a join request.
create function private.team_answer(p_user text, p_membership bigint, p_approve boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; r membership; o organisation; u portal_user;
begin
  m := private.team_owner(p_user);
  select * into r from membership where id = p_membership and organisation_id = m.organisation_id and status = 'join_requested';
  if r.id is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_approve then
    select * into o from organisation where id = m.organisation_id;
    if not private.team_open(o.status) then raise exception 'team refused: ORGANISATION_NOT_AVAILABLE company cannot take on people' using errcode = 'P0001'; end if;
    select * into u from portal_user where id = r.portal_user_id;
    if u.status <> 'active' or u.deleted_at is not null then raise exception 'team refused: REFUSED requester blocked or deleted' using errcode = 'P0001'; end if;
    if exists (select 1 from ban where email_domain = lower(split_part(u.email, '@', 2))) then raise exception 'team refused: REFUSED banned email domain' using errcode = 'P0001'; end if;
    update membership set status = 'active', joined_at = now() where id = r.id;
  else
    update membership set status = 'removed', removed_at = now() where id = r.id;
  end if;
  perform private.team_audit(p_user, case when p_approve then 'membership.approve' else 'membership.refuse' end, r.id,
    jsonb_build_object('status', 'join_requested'), jsonb_build_object('status', case when p_approve then 'active' else 'removed' end));
  return jsonb_build_object('membershipId', r.id);
end $$;

-- The owner removes another member or withdraws an invite. Access ends at once; what the member signed stays with the company (20b section 8).
create function private.team_remove(p_user text, p_membership bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; v_status text;
begin
  m := private.team_owner(p_user);
  select status into v_status from membership where id = p_membership and organisation_id = m.organisation_id and status in ('active','invited') and id <> m.id;
  if v_status is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  update membership set status = 'removed', removed_at = now(), invited_email = null, invite_token_hash = null where id = p_membership;
  perform private.team_audit(p_user, 'membership.remove', p_membership, jsonb_build_object('status', v_status), jsonb_build_object('status', 'removed'));
  return jsonb_build_object('membershipId', p_membership);
end $$;

-- A member leaves, or a login withdraws its own join request. The owner leaves only as the last active member (otherwise transfer
-- first); then the company's open invites and requests go too, and the company itself stays as it is, verified with its jobs (#132).
create function private.team_leave(p_user text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r membership; v_dropped integer := 0;
begin
  if not exists (select 1 from portal_user where id = p_user and status = 'active' and deleted_at is null) then
    raise exception 'team refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  select * into r from membership where portal_user_id = p_user and status in ('active','join_requested');
  if r.id is null then raise exception 'team refused: NOT_A_MEMBER' using errcode = 'P0001'; end if;
  perform 1 from organisation where id = r.organisation_id for no key update;
  select * into r from membership where id = r.id; -- again, after the lock
  if r.status not in ('active','join_requested') then raise exception 'team refused: NOT_A_MEMBER membership ended' using errcode = 'P0001'; end if;
  if r.status = 'active' and r.role = 'account_owner'
     and exists (select 1 from membership where organisation_id = r.organisation_id and status = 'active' and id <> r.id) then
    raise exception 'team refused: OWNER_MUST_TRANSFER' using errcode = 'P0001'; end if;
  update membership set status = 'removed', removed_at = now() where id = r.id;
  if not exists (select 1 from membership where organisation_id = r.organisation_id and status = 'active') then
    update membership set status = 'removed', removed_at = now(), invited_email = null, invite_token_hash = null
     where organisation_id = r.organisation_id and status in ('invited','join_requested','awaiting_approval');
    get diagnostics v_dropped = row_count;
  end if;
  perform private.team_audit(p_user, 'membership.leave', r.id, jsonb_build_object('status', r.status, 'role', r.role),
    jsonb_build_object('status', 'removed', 'dropped_pending', v_dropped));
  return jsonb_build_object('membershipId', r.id);
end $$;

-- The owner sets another member's role (viewer, poster or recruiter) and signer switch. A viewer never signs (#103).
create function private.team_set_role(p_user text, p_membership bigint, p_role text, p_signer boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; r membership;
begin
  m := private.team_owner(p_user);
  if p_role is null or p_role not in ('viewer','poster','recruiter') or p_signer is null then raise exception 'team refused: BAD_REQUEST role' using errcode = 'P0001'; end if;
  if p_role = 'viewer' and p_signer then raise exception 'team refused: VIEWER_NOT_SIGNER' using errcode = 'P0001'; end if;
  select * into r from membership where id = p_membership and organisation_id = m.organisation_id and status = 'active' and id <> m.id;
  if r.id is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  update membership set role = p_role, is_signer = p_signer where id = r.id;
  perform private.team_audit(p_user, 'membership.role', r.id, jsonb_build_object('role', r.role, 'is_signer', r.is_signer), jsonb_build_object('role', p_role, 'is_signer', p_signer));
  return jsonb_build_object('membershipId', r.id);
end $$;

-- The owner hands ownership to another active member. The old owner becomes a recruiter and keeps its signer switch; demote, then
-- promote, in one transaction (one_owner_per_org).
create function private.team_transfer(p_user text, p_membership bigint) returns jsonb
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
  return jsonb_build_object('membershipId', r.id);
end $$;

grant execute on function private.team_invite(text, text, text, boolean, text), private.team_accept(text, text), private.team_request(text, bigint),
  private.team_answer(text, bigint, boolean), private.team_remove(text, bigint), private.team_leave(text), private.team_set_role(text, bigint, text, boolean),
  private.team_transfer(text, bigint) to app_portal;

reset role;
