-- Step 15 staff tools, audit row Q2: staff act on a data request (queue data_request). Tests: packages/db/test/data-requests.test.ts.
--   1. private.data_request_account(item): the one account whose email is the requester's email on the item's contact message (candidate_user or
--      portal_user, the stored address lower case as Better Auth keeps it). Refused: not_found (no open data_request item), no_account,
--      several_accounts (a candidate and a portal login share the address), sender_not_account (a signed-in sender typed another login's address).
--      Caller's rights: app_admin already reads every table it touches.
--   2. private.portal_user_data(id): the portal login's own export, moved out of portal_account_export (0034) so the staff export is the same data.
--      portal_account_export keeps its session check and audit row and now returns this.
--   3. approval_request kind data_request_erase: target review_item/<item>, change {kind, userId}. One administrator proposes, a different
--      administrator confirms (approval_request_guard, the table check). private.data_request_erase(request) runs in the confirming transaction, uses
--      the request once, refuses when the item is no longer open or the account it names is no longer the match, then erases through erase_candidate
--      or erase_portal_user (their own refusals: open services case, open report as target, owner with members), empties the request message, closes
--      the item and writes one audit row naming both staff members (after the erase, so its pseudonymising leaves the row alone).
--   4. The candidate side of the staff export runs candidate.ts's own export statement as app_admin, so app_admin may read the few candidate rows it
--      lacked (tracker rows, sign-in providers, the candidate's consent, notice and notice-setting views) and run candidate_export_extras.
set role portal_owner;

create function private.data_request_account(p_item bigint) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare m contact_message; e text; hits jsonb;
begin
  select c.* into m from review_item i join contact_message c on c.id = i.contact_message_id
   where i.id = p_item and i.queue = 'data_request' and i.status in ('open','claimed');
  if m.id is null then raise exception 'data request refused: not_found' using errcode = 'P0001'; end if;
  e := lower(m.from_email);
  select coalesce(jsonb_agg(x), '[]') into hits from (
    select 'candidate' as kind, id as "userId" from candidate_user where email = e
    union all select 'portal', id from portal_user where email = e) x;
  if jsonb_array_length(hits) = 0 then raise exception 'data request refused: no_account' using errcode = 'P0001'; end if;
  if jsonb_array_length(hits) > 1 then raise exception 'data request refused: several_accounts' using errcode = 'P0001'; end if;
  if coalesce(m.candidate_user_id, m.portal_user_id) <> hits->0->>'userId' then -- a visitor's message names no login: null, so no refusal
    raise exception 'data request refused: sender_not_account' using errcode = 'P0001'; end if;
  return hits->0;
end $$;

create function private.portal_user_data(v text) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
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
      from case_document d where d.portal_user_id = v))
$$;

create or replace function private.portal_account_export(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := private.portal_session_user(p_token);
begin
  -- the audit row first, so this export is in "yourActions"
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, source)
    values ('data_access', v, 'portal_user.export', 'portal_user', v, 'site');
  return private.portal_user_data(v);
end $$;

alter table approval_request drop constraint approval_request_kind_check, add constraint approval_request_kind_check check (kind in ('threshold','critical_skills_list',
  'ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed',
  'grant_administrator','grant_role','terms_privacy_page','setting','company_seed','candidate_merge','data_request_erase'));

create function private.data_request_erase(p_request bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r approval_request; v_item bigint; v_msg bigint; a jsonb; res jsonb;
begin
  select * into r from approval_request where id = p_request and kind = 'data_request_erase';
  if r.id is null then raise exception 'data request refused: not_found' using errcode = 'P0001'; end if;
  perform private.use_approval(p_request, 'data_request_erase', 'review_item', r.target_id); -- confirmed, unused, and now used
  select * into r from approval_request where id = p_request;
  v_item := r.target_id::bigint;
  select contact_message_id into v_msg from review_item where id = v_item and queue = 'data_request' and status in ('open','claimed') for update;
  if not found then raise exception 'data request refused: not_open' using errcode = 'P0001'; end if;
  a := private.data_request_account(v_item);
  if a is distinct from r.change then raise exception 'data request refused: account_changed' using errcode = 'P0001'; end if;
  if a->>'kind' = 'candidate' then
    perform 1 from candidate_user where id = a->>'userId' for update;
    res := private.erase_candidate(a->>'userId', true);
  else
    perform 1 from portal_user where id = a->>'userId' for update;
    res := private.erase_portal_user(a->>'userId', true);
  end if;
  if not (res->>'erased')::boolean then raise exception 'data request refused: %', res->>'reason' using errcode = 'P0001'; end if;
  -- the request message itself goes too (a visitor's message names no login, so the erase did not reach it)
  update contact_message set from_name = null, from_email = null, body = null, candidate_user_id = null, portal_user_id = null where id = v_msg;
  update review_item set status = 'done', outcome = 'erased', decided_by_staff_user_id = r.confirmed_by_staff_user_id, decided_at = now(),
         candidate_user_id = null, portal_user_id = null where id = v_item and status in ('open','claimed');
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, second_staff_user_id, source)
    values ('admin_action', r.confirmed_by_staff_user_id, 'data_request.erase', 'review_item', v_item::text,
            jsonb_build_object('kind', a->>'kind', 'request_id', p_request::text), r.proposed_by_staff_user_id, 'panel');
  return jsonb_build_object('kind', a->>'kind', 'userId', a->>'userId', 'storage_keys', res->'storage_keys');
end $$;

revoke all on function private.data_request_account(bigint), private.portal_user_data(text), private.data_request_erase(bigint) from public, anon, authenticated, service_role;
grant execute on function private.data_request_account(bigint), private.portal_user_data(text), private.data_request_erase(bigint) to app_admin;
grant execute on function private.candidate_export_extras(text) to app_admin;
grant select on tracker_entry, candidate_consent_record, candidate_notification, candidate_notification_preference to app_admin;
grant select (user_id, provider_id) on candidate_account to app_admin;

reset role;
