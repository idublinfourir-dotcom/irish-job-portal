-- Step 15 services wave gap round (20 Nov 2026). Tests: packages/db/test/candidate-export.test.ts, data-requests.test.ts, candidate-merge.test.ts.
--   1. private.portal_user_data (last defined in 0050_data_requests.sql): servicesRequests also lists decisionOutcome and closeReason (G2). Offer
--      details stay out on purpose: they may name a candidate.
--   2. private.candidate_merge (last defined in 0048_candidate_merge.sql): the dropped account's services cases (closed; an open one is still
--      refused) move to the kept account with their consent records, the copies the person uploaded and the person's own timeline events,
--      before the erase, so they keep their history (G4). The moved case ids are in the audit row's moved detail (servicesCaseIds).
--   Both texts are copied from those migrations; only the lines named above are new. Grants are kept by create or replace.
set role portal_owner;

-- ===== 1. the portal export
create or replace function private.portal_user_data(v text) returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
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
        'closedAt', c.closed_at, 'decisionOutcome', c.decision_outcome, 'closeReason', c.close_reason) order by c.created_at desc, c.id desc), '[]') from services_case c where c.portal_user_id = v),
    'documentsYouUploaded', (select coalesce(jsonb_agg(jsonb_build_object('caseId', d.services_case_id::text, 'fileName', d.file_name, 'contentType', d.content_type,
        'byteSize', d.byte_size, 'uploadedAt', d.uploaded_at, 'copyDeletedAt', d.copy_deleted_at) order by d.uploaded_at desc, d.id desc), '[]')
      from case_document d where d.portal_user_id = v))
$$;

-- ===== 2. the candidate merge
create or replace function private.candidate_merge(p_request bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r approval_request; v_keep text; v_drop text; n int; moved jsonb := '{}'; res jsonb; keys jsonb;
  apps bigint[]; app_keys text[]; reqs bigint[]; cases bigint[];
begin
  select * into r from approval_request where id = p_request and kind = 'candidate_merge';
  if r.id is null then raise exception 'merge refused: not_found' using errcode = 'P0001'; end if;
  v_keep := r.change->>'keep'; v_drop := r.change->>'drop';
  if v_keep is null or v_drop is distinct from r.target_id or v_keep = v_drop then raise exception 'merge refused: bad_request' using errcode = 'P0001'; end if;
  perform private.use_approval(p_request, 'candidate_merge', 'candidate_user', v_drop); -- confirmed, unused, and now used
  select * into r from approval_request where id = p_request;
  -- both logins, in id order (two merges at once take turns); the lock also holds back the person's own writes to either account
  perform 1 from candidate_user where id in (v_keep, v_drop) order by id for update;
  if (select count(*) from candidate_user where id in (v_keep, v_drop)) <> 2 then raise exception 'merge refused: not_found' using errcode = 'P0001'; end if;
  if (select deleted_at is not null from candidate_user where id = v_keep) then raise exception 'merge refused: kept_account_deleted' using errcode = 'P0001'; end if;
  if exists (select 1 from services_case where candidate_user_id in (v_keep, v_drop) and status <> 'closed') then
    raise exception 'merge refused: open_services_case' using errcode = 'P0001'; end if;
  if exists (select 1 from report where (target_candidate_user_id in (v_keep, v_drop) or reporter_candidate_user_id in (v_keep, v_drop)) and status in ('open','job_hidden')) then
    raise exception 'merge refused: open_report' using errcode = 'P0001'; end if;

  -- 200 saved jobs a person at most (candidate_job_check, 0020): the dropped account's oldest first while room is left
  update saved_job set candidate_user_id = v_keep where id in (select s.id from saved_job s where s.candidate_user_id = v_drop
    and not exists (select 1 from saved_job k where k.candidate_user_id = v_keep and k.job_id = s.job_id) order by s.id
    limit greatest(0, 200 - (select count(*) from saved_job where candidate_user_id = v_keep)));
  get diagnostics n = row_count; moved := moved || jsonb_build_object('savedJobs', n);
  -- 10 alerts a person at most (alerts.ts MAX_ALERTS): the kept account's all stay, then the dropped account's oldest while room is left
  update alert set candidate_user_id = v_keep where id in (select id from alert where candidate_user_id = v_drop order by id
    limit greatest(0, 10 - (select count(*) from alert where candidate_user_id = v_keep)));
  get diagnostics n = row_count; moved := moved || jsonb_build_object('alerts', n);
  update tracker_entry t set candidate_user_id = v_keep where candidate_user_id = v_drop
    and not exists (select 1 from tracker_entry k where k.candidate_user_id = v_keep and k.job_id = t.job_id);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('tracker', n);
  update candidate_hidden_organisation h set candidate_user_id = v_keep where candidate_user_id = v_drop
    and not exists (select 1 from candidate_hidden_organisation k where k.candidate_user_id = v_keep and k.organisation_id = h.organisation_id);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('hiddenOrganisations', n);
  -- the profile and the CV only when the kept account has none (one each a person); a moved CV keeps its stored file
  update candidate_profile set candidate_user_id = v_keep where candidate_user_id = v_drop and not exists (select 1 from candidate_profile where candidate_user_id = v_keep);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('profile', n);
  update candidate_cv set candidate_user_id = v_keep where candidate_user_id = v_drop and not exists (select 1 from candidate_cv where candidate_user_id = v_keep);
  get diagnostics n = row_count; moved := moved || jsonb_build_object('cv', n);
  -- applications (one a job a person) with their consent records, CV keys and the person's messages in them
  with u as (update application a set candidate_user_id = v_keep where candidate_user_id = v_drop
              and not exists (select 1 from application k where k.candidate_user_id = v_keep and k.job_id = a.job_id) returning id, consent_record_id, cv_storage_key)
  select coalesce(array_agg(id), '{}'), coalesce(array_agg(cv_storage_key) filter (where cv_storage_key is not null), '{}') into apps, app_keys from u;
  update consent_record set candidate_user_id = v_keep where candidate_user_id = v_drop and id in (select consent_record_id from application where id = any(apps));
  update message set sender_candidate_user_id = v_keep where sender_candidate_user_id = v_drop and application_id = any(apps);
  moved := moved || jsonb_build_object('applications', cardinality(apps));
  -- contact requests (one open request a company a person), with their consent records and messages
  with u as (update contact_request c set candidate_user_id = v_keep where candidate_user_id = v_drop
              and not (status = 'sent' and exists (select 1 from contact_request k where k.candidate_user_id = v_keep and k.organisation_id = c.organisation_id and k.status = 'sent'))
              returning id)
  select coalesce(array_agg(id), '{}') into reqs from u;
  update consent_record set candidate_user_id = v_keep where candidate_user_id = v_drop and id in (select consent_record_id from contact_request where id = any(reqs));
  update message set sender_candidate_user_id = v_keep where sender_candidate_user_id = v_drop and contact_request_id = any(reqs);
  moved := moved || jsonb_build_object('contactRequests', cardinality(reqs));
  -- the dropped account's services cases (all closed: an open one is refused above), so the person keeps their history (0064). Their consent
  -- records first (services_case_guard, 0005: a case rests on the same person's records), then the cases, the copies they uploaded
  -- (case_document_guard) and their own timeline events. Staff copies and staff events stay as they are.
  select coalesce(array_agg(id order by id), '{}') into cases from services_case where candidate_user_id = v_drop;
  update consent_record set candidate_user_id = v_keep where candidate_user_id = v_drop
    and id in (select consent_record_id from services_case where id = any(cases) union select employer_contact_consent_record_id from services_case where id = any(cases));
  update services_case set candidate_user_id = v_keep where id = any(cases);
  update case_document set candidate_user_id = v_keep where candidate_user_id = v_drop and services_case_id = any(cases);
  update case_event set candidate_user_id = v_keep where candidate_user_id = v_drop and case_id = any(cases);
  moved := moved || jsonb_build_object('servicesCases', cardinality(cases), 'servicesCaseIds', to_jsonb(array(select c::text from unnest(cases) c)));

  res := private.erase_candidate(v_drop, true);
  if not (res->>'erased')::boolean then raise exception 'merge refused: %', res->>'reason' using errcode = 'P0001'; end if;
  select coalesce(jsonb_agg(k), '[]') into keys from jsonb_array_elements_text(res->'storage_keys') k where k <> all(app_keys);

  insert into notification(candidate_user_id, category, template_key, params, dedupe_key)
    values (v_keep, 'account', 'account_merged', '{}', 'account_merged:' || p_request);
  insert into email_outbox(template, candidate_user_id, dedupe_key) values ('account_merged', v_keep, 'account_merged:' || p_request);
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, subject_candidate_user_id, after, second_staff_user_id, source)
    values ('admin_action', r.confirmed_by_staff_user_id, 'candidate_merge.confirm', 'candidate_user', v_keep, v_keep,
            jsonb_build_object('dropped', v_drop, 'request_id', p_request::text, 'moved', moved), r.proposed_by_staff_user_id, 'panel');
  return jsonb_build_object('keep', v_keep, 'drop', v_drop, 'moved', moved, 'storage_keys', keys);
end $$;

reset role;
