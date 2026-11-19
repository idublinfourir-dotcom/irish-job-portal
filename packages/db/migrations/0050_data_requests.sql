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
--      or erase_portal_user (their own refusals: open services case, open report as target, owner with members, sole owner of an open company),
--      empties every visitor message sent from the requester's address (the request's own among them) and closes the open items that point to them,
--      closes the item and writes one audit row naming both staff members (after the erase, so its pseudonymising leaves the row alone).
--   4. The owner confirms by email (decision #271). Staff send a confirm (staff-tools.ts sendDataRequestConfirm): review_item.detail gets {purpose
--      export|erase, kind, userId, sentBy, sentAt} and the outbox gets one data_request_confirm row for the matched login (so it goes to that login's
--      own address, never the typed one). The outbox sender makes the token when it sends, keeps only its sha256 in detail.confirmHash with
--      detail.expiresAt (7 days), and links to the login's own site. private.data_request_peek(hash, kind) shows a live link's purpose and changes
--      nothing; private.data_request_confirm(hash, kind) uses it once (the hash goes, detail.confirmedAt is set, one audit row by the owner) and, for a
--      portal export, returns the data (a candidate's export runs candidate.ts's own statement as app_candidate in the same transaction). Staff never
--      get anyone's export. private.data_request_proved(item): the matched account, when the request is proved for an erase (sent by that login while
--      signed in, or confirmed by its owner for an erase), else not_confirmed; erase_propose and data_request_erase both ask it.
--   5. Sole owner (gap round): erase_portal_user also refuses (close_company_first) the active account owner of an open company with no other active
--      member, as the self delete did on its own (0034), so no erase leaves a company with no owner. The check moves here with the company lock;
--      portal_account_delete keeps its code CLOSE_COMPANY_FIRST through the reason. The retention rules that erase portal logins (7, 9, 14) leave such a
--      login out of their due rows (as an owner with members already is), and run_retention writes one scheduled_check reminder for administrators
--      per company and month (reason sole_owner_retention, detail.organisationId, read at /api/scheduled-checks): close the company, or a member
--      joins and takes the owner role, and the next run erases the login.
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

-- 4. the owner's confirmation by email
create unique index review_item_confirm_hash_unique on review_item((detail->>'confirmHash')) where queue = 'data_request';

create function private.data_request_proved(p_item bigint) returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare a jsonb := private.data_request_account(p_item); d jsonb; sender text;
begin
  select i.detail, coalesce(m.candidate_user_id, m.portal_user_id) into d, sender from review_item i join contact_message m on m.id = i.contact_message_id where i.id = p_item;
  if sender is not distinct from a->>'userId' then return a; end if; -- sent by the login itself while signed in
  if d->>'purpose' = 'erase' and d->>'confirmedAt' is not null and d->>'kind' = a->>'kind' and d->>'userId' = a->>'userId' then return a; end if;
  raise exception 'data request refused: not_confirmed' using errcode = 'P0001';
end $$;

-- A live link: the item open, the hash known, not expired, of this site's kind of login. Anything else is the same refusal.
create function private.data_request_live(p_hash text, p_kind text) returns review_item language plpgsql stable set search_path = public, pg_temp as $$
declare i review_item;
begin
  select * into i from review_item where queue = 'data_request' and detail->>'confirmHash' = p_hash and status in ('open','claimed');
  if i.id is null or (i.detail->>'expiresAt')::timestamptz <= now() or i.detail->>'kind' is distinct from p_kind then
    raise exception 'data request refused: invalid_link' using errcode = 'P0001'; end if;
  return i;
end $$;

create function private.data_request_peek(p_hash text, p_kind text) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('purpose', i.detail->>'purpose', 'expiresAt', i.detail->>'expiresAt') from private.data_request_live(p_hash, p_kind) i
$$;

create function private.data_request_confirm(p_hash text, p_kind text) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare i review_item := private.data_request_live(p_hash, p_kind); a jsonb; v text;
begin
  perform 1 from review_item where id = i.id for update;
  select * into i from private.data_request_live(p_hash, p_kind); -- again under the lock: two clicks at once, one wins
  a := private.data_request_account(i.id);
  v := a->>'userId';
  if a->>'kind' <> i.detail->>'kind' or v <> i.detail->>'userId' then raise exception 'data request refused: invalid_link' using errcode = 'P0001'; end if;
  update review_item set detail = (detail - 'confirmHash') || jsonb_build_object('confirmedAt', now()) where id = i.id;
  insert into audit_event(kind, actor_candidate_user_id, actor_portal_user_id, action, object_type, object_id, subject_candidate_user_id, after, source)
    values ('security', case when p_kind = 'candidate' then v end, case when p_kind = 'portal' then v end, 'data_request.confirm', 'review_item', i.id::text,
            case when p_kind = 'candidate' then v end, jsonb_build_object('purpose', i.detail->>'purpose'), 'site');
  return jsonb_build_object('purpose', i.detail->>'purpose', 'userId', v,
    'data', case when p_kind = 'portal' and i.detail->>'purpose' = 'export' then private.portal_user_data(v) end);
end $$;

create function private.data_request_erase(p_request bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare r approval_request; v_item bigint; v_email text; a jsonb; res jsonb;
begin
  select * into r from approval_request where id = p_request and kind = 'data_request_erase';
  if r.id is null then raise exception 'data request refused: not_found' using errcode = 'P0001'; end if;
  perform private.use_approval(p_request, 'data_request_erase', 'review_item', r.target_id); -- confirmed, unused, and now used
  select * into r from approval_request where id = p_request;
  v_item := r.target_id::bigint;
  perform 1 from review_item where id = v_item and queue = 'data_request' and status in ('open','claimed') for update;
  if not found then raise exception 'data request refused: not_open' using errcode = 'P0001'; end if;
  select lower(m.from_email) into v_email from review_item i join contact_message m on m.id = i.contact_message_id where i.id = v_item;
  a := private.data_request_proved(v_item);
  if a is distinct from r.change then raise exception 'data request refused: account_changed' using errcode = 'P0001'; end if;
  if a->>'kind' = 'candidate' then
    perform 1 from candidate_user where id = a->>'userId' for update;
    res := private.erase_candidate(a->>'userId', true);
  else
    perform 1 from portal_user where id = a->>'userId' for update;
    res := private.erase_portal_user(a->>'userId', true);
  end if;
  if not (res->>'erased')::boolean then raise exception 'data request refused: %', res->>'reason' using errcode = 'P0001'; end if;
  update review_item set status = 'done', outcome = 'erased', decided_by_staff_user_id = r.confirmed_by_staff_user_id, decided_at = now(),
         candidate_user_id = null, portal_user_id = null, detail = null where id = v_item and status in ('open','claimed');
  -- the erase empties the messages the login sent; a visitor's message names no login, so every one from this address goes here (the request's own
  -- among them), and the open items that point to them (other data requests) close as the erase closes its own.
  -- ponytail: no index on lower(from_email), a scan of contact_message per erase (rare, staff only); add one if the table grows large.
  with m as (update contact_message set from_name = null, from_email = null, body = null
              where lower(from_email) = v_email and candidate_user_id is null and portal_user_id is null returning id)
  update review_item set status = 'done', outcome = 'subject_erased', decided_at = now(), contact_message_id = null
   where status in ('open','claimed') and contact_message_id in (select id from m);
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, after, second_staff_user_id, source)
    values ('admin_action', r.confirmed_by_staff_user_id, 'data_request.erase', 'review_item', v_item::text,
            jsonb_build_object('kind', a->>'kind', 'request_id', p_request::text), r.proposed_by_staff_user_id, 'panel');
  return jsonb_build_object('kind', a->>'kind', 'userId', a->>'userId', 'storage_keys', res->'storage_keys');
end $$;

-- 5. erase_portal_user: 0002's text with the sole-owner check first (under the company lock, as 0034's portal_account_delete took it).
create or replace function private.erase_portal_user(p_id text, p_on_request boolean) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare v_email text; k text[]; keys text[] := '{}'; stand_in text := 'erased-' || gen_random_uuid()::text; ms membership;
begin
  select email into v_email from portal_user where id = p_id;
  if not found then return jsonb_build_object('erased', false, 'reason', 'not_found'); end if;
  select * into ms from membership where portal_user_id = p_id and status = 'active';
  if ms.id is not null then
    perform 1 from organisation where id = ms.organisation_id for no key update; -- as team_leave: no member joins or leaves while this decides
    select * into ms from membership where id = ms.id;
    if ms.status = 'active' and ms.role = 'account_owner' and private.team_open((select status from organisation where id = ms.organisation_id))
       and not exists (select 1 from membership o where o.organisation_id = ms.organisation_id and o.status = 'active' and o.id <> ms.id) then
      return jsonb_build_object('erased', false, 'reason', 'close_company_first'); end if;
  end if;
  if exists (select 1 from services_case where portal_user_id = p_id and status <> 'closed') then
    return jsonb_build_object('erased', false, 'reason', 'open_services_case'); end if;
  if exists (select 1 from membership m where m.portal_user_id = p_id and m.status = 'active' and m.role = 'account_owner'
             and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id)) then
    return jsonb_build_object('erased', false, 'reason', 'owner_with_members'); end if;
  update membership set status = 'removed', removed_at = coalesce(removed_at, now()), invited_email = null, invite_token_hash = null where portal_user_id = p_id;
  update consent_record set subject_erased_at = now(), job_id = null, organisation_id = null, details = null where portal_user_id = p_id;
  update services_case set requester_erased_at = now() where portal_user_id = p_id;
  select coalesce(array_agg(storage_key) filter (where storage_key is not null), '{}') into k from case_document where portal_user_id = p_id; keys := keys || k;
  update case_document set storage_key = null, file_name = null, copy_deleted_at = now() where portal_user_id = p_id and storage_key is not null;
  update report set reporter_wiped_at = now() where reporter_portal_user_id = p_id;
  update review_item set status = 'done', outcome = 'subject_erased', decided_at = now(), portal_user_id = null, contact_message_id = null
   where status in ('open','claimed') and (portal_user_id = p_id or contact_message_id in (select id from contact_message where portal_user_id = p_id));
  delete from email_outbox where portal_user_id = p_id and status = 'pending';
  update email_outbox set portal_user_id = stand_in, params = null where portal_user_id = p_id and status in ('sending','sent','failed','dropped');
  update contact_message set from_name = null, from_email = null,
         body = case when p_on_request then null else body end, portal_user_id = case when p_on_request then null else portal_user_id end
   where portal_user_id = p_id;
  delete from portal_session where user_id = p_id;
  delete from portal_account where user_id = p_id;
  delete from portal_verification where value = p_id or identifier = v_email;
  insert into audit_event(kind, actor_system, action, object_type, object_id, source)
    values ('admin_action', 'erase_portal_user by ' || session_user, 'portal_user.erase', 'portal_user', p_id, 'scheduled_job');
  delete from portal_user where id = p_id;
  perform private.audit_pseudonymise(p_id);
  return jsonb_build_object('erased', true, 'storage_keys', to_jsonb(keys));
end $$;

-- 5. the self delete: its own check now lives in erase_portal_user; the reasons map to the same codes as before.
create or replace function private.portal_account_delete(p_token text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v text := private.portal_session_user(p_token); r jsonb;
begin
  r := private.erase_portal_user(v, true);
  if (r->>'erased')::boolean is not true then
    raise exception 'account refused: %', case r->>'reason' when 'open_services_case' then 'OPEN_SERVICES_CASE' when 'owner_with_members' then 'OWNER_MUST_TRANSFER'
      when 'close_company_first' then 'CLOSE_COMPANY_FIRST' else 'REFUSED' end using errcode = 'P0001';
  end if;
  return r;
end $$;

-- 5. retention rules 7, 9 and 14: an active owner is left out while the company is open, or while other members are active (as before).
do $m$
declare
  old_sql constant text := $o$exists (select 1 from membership m where m.portal_user_id = u.id and m.status = 'active' and m.role = 'account_owner' and exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id))$o$;
  new_sql constant text := $o$exists (select 1 from membership m join organisation g on g.id = m.organisation_id where m.portal_user_id = u.id and m.status = 'active' and m.role = 'account_owner' and (private.team_open(g.status) or exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id)))$o$;
  def text := pg_get_functiondef('private.retention_rules()'::regprocedure);
begin
  if (length(def) - length(replace(def, old_sql, ''))) <> 3 * length(old_sql) then raise exception '0050: the owner refusal not found exactly three times'; end if;
  execute replace(def, old_sql, new_sql);
end $m$;

-- 5. run_retention: before an erase_portal_user rule's skipped rows are listed, one reminder per company and month for each sole owner left out.
do $m$
declare
  anchor constant text := '    -- rows an open case freezes, or an erase function would refuse, are left out of the due rows and listed';
  block constant text := $o$    -- 0050: a sole owner of an open company is left out; administrators get one reminder per company and month (/api/scheduled-checks)
    if rule.kind = 'erase_portal_user' then
      execute $s$insert into review_item(queue, reason, detail)
        select distinct 'scheduled_check', 'sole_owner_retention', jsonb_build_object('role', 'administrator', 'organisationId', m.organisation_id::text,
               'key', 'sole_owner_retention:' || m.organisation_id || ':' || to_char(now() at time zone 'Europe/Dublin', 'YYYY-MM'))
          from ($s$ || due_sql || $s$) x join membership m on m.portal_user_id = x.id and m.status = 'active' and m.role = 'account_owner'
          join organisation g on g.id = m.organisation_id
         where private.team_open(g.status) and not exists (select 1 from membership o where o.organisation_id = m.organisation_id and o.status = 'active' and o.id <> m.id)
        on conflict ((detail->>'key')) where queue = 'scheduled_check' do nothing$s$ using v;
    end if;
$o$;
  def text := pg_get_functiondef('private.run_retention(integer)'::regprocedure);
begin
  if (length(def) - length(replace(def, anchor, ''))) <> length(anchor) then raise exception '0050: run_retention anchor not found exactly once'; end if;
  execute replace(def, anchor, block || anchor);
end $m$;

revoke all on function private.data_request_account(bigint), private.portal_user_data(text), private.data_request_erase(bigint), private.data_request_proved(bigint),
  private.data_request_live(text, text), private.data_request_peek(text, text), private.data_request_confirm(text, text) from public, anon, authenticated, service_role;
grant execute on function private.data_request_account(bigint), private.data_request_proved(bigint), private.data_request_erase(bigint) to app_admin;
grant execute on function private.data_request_peek(text, text), private.data_request_confirm(text, text) to app_candidate, app_portal;

reset role;
