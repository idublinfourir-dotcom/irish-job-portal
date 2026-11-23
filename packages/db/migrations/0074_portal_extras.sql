-- Step 16 backend round 2, agent p2 (B54, B55, B56):
--   1. B54 (frame E18): private.company_logo takes the logo's public address too and stores it in organisation.logo_url, which the public pages read.
--      The old two-argument function is dropped. The address is the portal's own GET /api/portal/company/logo/<uuid>.<ext> (it serves the stored,
--      scanned, re-encoded file with no login), built by the route from its own origin and the key.
--   2. B55 (frame E19): private.team_resend: the owner sends a live or expired invite again with a new token (the old link stops working) and 7 more
--      days. Not again within 5 minutes of the last send (RESEND_TOO_SOON), so one invitee's inbox cannot be flooded through us.
--   3. B56 (frame E20): strike.notified_at, set when staff notify the employer (the start of the 7 day reply window), backfilled from reply_due_at
--      (always 7 days after the notice); private.status_page returns it and the case's created_at. Still never the report, the reporter, a staff id
--      or a received date.
set role portal_owner;

-- ===== 1. the logo's public address
drop function private.company_logo(text, text);
create function private.company_logo(p_user text, p_key text, p_url text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership; o organisation;
begin
  m := private.team_owner(p_user);
  select * into o from organisation where id = m.organisation_id;
  if not private.team_open(o.status) then raise exception 'company refused: ORGANISATION_NOT_AVAILABLE' using errcode = 'P0001'; end if;
  if p_url is null or length(p_url) > 300 or p_url !~ '^https?://[^/?#\s]+/api/portal/company/logo/[0-9a-f-]{36}\.(png|jpg|webp)$' or p_url not like '%' || substr(p_key, 6) then
    raise exception 'company refused: BAD_REQUEST logo address' using errcode = 'P0001'; end if;
  update organisation set logo_key = p_key, logo_url = p_url where id = o.id; -- the column's check refuses any other key shape
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, changed_columns, source)
    values ('security', p_user, 'organisation.logo', 'organisation', o.id::text, '{logo_key,logo_url}', 'site');
  return jsonb_build_object('organisationId', o.id, 'oldKey', o.logo_key);
end $$;
grant execute on function private.company_logo(text, text, text) to app_portal;
create index organisation_logo_key_idx on organisation(logo_key) where logo_key is not null; -- the public logo route looks the key up on every view

-- ===== 2. the owner sends an invite again
create function private.team_resend(p_user text, p_membership bigint, p_token_hash text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.team_owner(p_user); i membership; v_exp timestamptz := now() + interval '7 days';
begin
  if not private.team_open((select status from organisation where id = m.organisation_id)) then
    raise exception 'team refused: ORGANISATION_NOT_AVAILABLE company cannot take on people' using errcode = 'P0001'; end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then raise exception 'team refused: BAD_REQUEST token hash' using errcode = 'P0001'; end if;
  select * into i from membership where id = p_membership and organisation_id = m.organisation_id and status = 'invited' for update;
  if i.id is null then raise exception 'team refused: MEMBER_NOT_FOUND' using errcode = 'P0001'; end if;
  if i.invite_expires_at - interval '7 days' > now() - interval '5 minutes' then raise exception 'team refused: RESEND_TOO_SOON' using errcode = 'P0001'; end if;
  if exists (select 1 from ban where email_domain = split_part(lower(i.invited_email), '@', 2)) then raise exception 'team refused: REFUSED banned email domain' using errcode = 'P0001'; end if;
  update membership set invite_token_hash = p_token_hash, invite_expires_at = v_exp where id = i.id;
  perform private.team_audit(p_user, 'membership.resend', i.id, null, jsonb_build_object('status', 'invited'));
  return jsonb_build_object('membershipId', i.id, 'email', i.invited_email, 'expiresAt', v_exp);
end $$;
grant execute on function private.team_resend(text, bigint, text) to app_portal;

-- ===== 3. the notice time on a case
alter table strike add column notified_at timestamptz;
update strike set notified_at = reply_due_at - interval '7 days' where reply_due_at is not null;
grant update (notified_at) on strike to app_admin;

create or replace function private.status_page(p_user text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user); v_owner boolean := m.role = 'account_owner';
begin
  return (select jsonb_build_object(
    'organisationId', o.id, 'status', o.status, 'restrictedUntil', o.restricted_until, 'claimsRemovedAt', o.claims_removed_at, 'isOwner', v_owner,
    'strikesLast12Months', (select count(*) from strike s where s.organisation_id = o.id and s.outcome = 'strike' and s.stage <> 'overturned'
                              and s.decided_at > now() - interval '12 months'),
    'cases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'caseKind', s.case_kind, 'reasonCode', s.reason_code, 'jobId', s.job_id, 'jobTitle', j.title, 'noticeSummary', s.notice_summary,
        'stage', s.stage, 'outcome', s.outcome, 'level', s.level, 'createdAt', s.created_at, 'notifiedAt', s.notified_at,
        'replyDueAt', s.reply_due_at, 'employerReply', s.employer_reply, 'repliedAt', s.replied_at,
        'decidedAt', s.decided_at, 'appealDueAt', s.appeal_due_at, 'appealText', s.appeal_text, 'appealedAt', s.appealed_at,
        'appealDecidedAt', s.appeal_decided_at,
        'canReply', v_owner and s.decided_at is null and s.employer_reply is null and now() <= s.reply_due_at,
        'canAppeal', v_owner and s.decided_at is not null and s.appealed_at is null and s.appeal_decided_at is null and now() <= s.appeal_due_at)
        order by s.id desc)
      from strike s left join job j on j.id = s.job_id
      where s.organisation_id = o.id and (s.reply_due_at is not null or s.decided_at is not null)), '[]'::jsonb))
    from organisation o where o.id = m.organisation_id);
end $$;

reset role;
