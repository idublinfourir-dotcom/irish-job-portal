-- Step 15, audit row R1: an employer or agency login downloads its own data and deletes itself.
--   1. private.portal_session_user(token): the active, not deleted portal login that owns this live session token, or the refusal NO_SESSION.
--      Both functions below take the session token, not a user id, so app_portal cannot export or erase a login whose live session it does not hold.
--      (app_portal can read portal_session, as Better Auth needs, so this guards against a wrong id from app code, not against a hostile app_portal session.)
--   2. private.portal_account_export(token): the login's own data as one jsonb, and one audit row (data_access, portal_user.export). Never another member's
--      personal data, staff names, notes or other companies' data.
--   3. private.portal_account_delete(token): refuses the active account owner of an open company with no other active member (close the company first,
--      P12), then calls private.erase_portal_user(id, true), which refuses an open services case and an owner with other active members. Raised, so
--      nothing changes on a refusal. Returns the erase result: the stored files to remove (storage_keys).
-- Execute: app_portal only, on the two outer functions. private.erase_portal_user stays app_admin only.
set role portal_owner;

create function private.portal_session_user(p_token text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v text;
begin
  select u.id into v from portal_session s join portal_user u on u.id = s.user_id
   where s.token = p_token and s.expires_at > now() and u.status = 'active' and u.deleted_at is null;
  if v is null then raise exception 'account refused: NO_SESSION' using errcode = 'P0001'; end if;
  return v;
end $$;

create function private.portal_account_export(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := private.portal_session_user(p_token); res jsonb;
begin
  -- the audit row first, so this export is in "yourActions"
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source)
    values ('data_access', v, 'portal_user.export', 'portal_user', v, 'site');
  select jsonb_build_object(
    'account', (select jsonb_build_object('name', u.name, 'email', u.email, 'emailConfirmed', u.email_verified, 'createdAt', u.created_at, 'lastActiveAt', u.last_active_at,
        'signInMethods', (select coalesce(jsonb_agg(distinct a.provider_id), '[]') from portal_account a where a.user_id = u.id)) from portal_user u where u.id = v),
    'memberships', (select coalesce(jsonb_agg(jsonb_build_object('organisationId', o.id, 'organisation', o.display_name, 'role', m.role, 'isSigner', m.is_signer,
        'status', m.status, 'joinedAt', m.joined_at, 'removedAt', m.removed_at) order by m.id), '[]')
      from membership m join organisation o on o.id = m.organisation_id where m.portal_user_id = v),
    'notices', (select coalesce(jsonb_agg(jsonb_build_object('category', n.category, 'templateKey', n.template_key, 'params', n.params, 'createdAt', n.created_at,
        'readAt', n.read_at) order by n.created_at desc, n.id desc), '[]') from notification n where n.portal_user_id = v),
    'notificationSettings', (select coalesce(jsonb_agg(jsonb_build_object('category', p.category, 'channel', p.channel, 'enabled', p.enabled) order by p.category, p.channel), '[]')
      from notification_preference p where p.portal_user_id = v),
    'consents', (select coalesce(jsonb_agg(jsonb_build_object('purpose', x.purpose, 'textVersion', x.version, 'givenAt', c.given_at, 'withdrawnAt', c.withdrawn_at,
        'organisation', o.display_name) order by c.given_at, c.id), '[]')
      from consent_record c join consent_text x on x.id = c.consent_text_id left join organisation o on o.id = c.organisation_id where c.portal_user_id = v),
    'emailsWeSent', (select coalesce(jsonb_agg(jsonb_build_object('template', e.template, 'status', e.status, 'sendAfter', e.send_after, 'sentAt', e.sent_at)
        order by e.send_after desc, e.id desc), '[]') from email_outbox e where e.portal_user_id = v),
    'yourActions', (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'action', a.action, 'objectType', a.object_type, 'at', a.at)
        order by a.at desc, a.id desc), '[]') from audit_event a where a.actor_portal_user_id = v),
    'reportsYouMade', (select coalesce(jsonb_agg(jsonb_build_object('id', r.id::text, 'targetKind', r.target_kind, 'reason', r.reason, 'evidenceText', r.evidence_text,
        'status', r.status, 'createdAt', r.created_at, 'decidedAt', r.decided_at) order by r.created_at desc, r.id desc), '[]') from report r where r.reporter_portal_user_id = v),
    'messagesYouSent', (select coalesce(jsonb_agg(jsonb_build_object('topic', m.topic, 'body', m.body, 'status', m.status, 'createdAt', m.created_at)
        order by m.created_at desc, m.id desc), '[]') from contact_message m where m.portal_user_id = v),
    -- the case's status and dates only: offer_details may name a candidate, who is someone else
    'servicesRequests', (select coalesce(jsonb_agg(jsonb_build_object('id', c.id::text, 'permitType', c.permit_type, 'status', c.status, 'createdAt', c.created_at,
        'closedAt', c.closed_at) order by c.created_at desc, c.id desc), '[]') from services_case c where c.portal_user_id = v),
    'documentsYouUploaded', (select coalesce(jsonb_agg(jsonb_build_object('caseId', d.services_case_id::text, 'fileName', d.file_name, 'contentType', d.content_type,
        'byteSize', d.byte_size, 'uploadedAt', d.uploaded_at, 'copyDeletedAt', d.copy_deleted_at) order by d.uploaded_at desc, d.id desc), '[]')
      from case_document d where d.portal_user_id = v)
  ) into res;
  return res;
end $$;

create function private.portal_account_delete(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := private.portal_session_user(p_token); m membership; r jsonb;
begin
  select * into m from membership where portal_user_id = v and status = 'active';
  if m.id is not null then
    perform 1 from organisation where id = m.organisation_id for no key update; -- as team_leave: no member joins or leaves while this decides
    select * into m from membership where id = m.id;
    if m.status = 'active' and m.role = 'account_owner' and private.team_open((select status from organisation where id = m.organisation_id))
       and not exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id) then
      raise exception 'account refused: CLOSE_COMPANY_FIRST' using errcode = 'P0001'; end if;
  end if;
  r := private.erase_portal_user(v, true);
  if (r->>'erased')::boolean is not true then
    raise exception 'account refused: %', case r->>'reason' when 'open_services_case' then 'OPEN_SERVICES_CASE' when 'owner_with_members' then 'OWNER_MUST_TRANSFER' else 'REFUSED' end
      using errcode = 'P0001';
  end if;
  return r;
end $$;

revoke all on function private.portal_session_user(text), private.portal_account_export(text), private.portal_account_delete(text) from public, anon, authenticated, service_role;
grant execute on function private.portal_account_export(text), private.portal_account_delete(text) to app_portal;

reset role;
