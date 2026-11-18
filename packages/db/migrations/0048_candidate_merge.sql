-- Step 15 gap 4 (audit row C6): an administrator merges two candidate accounts of one person. Tests: packages/db/test/candidate-merge.test.ts.
--   1. approval_request kind candidate_merge: target candidate_user/<drop>, change {keep, drop}. One administrator proposes, a different administrator
--      confirms (approval_request_guard: only an administrator confirms this kind; the table check: never the proposer).
--   2. private.candidate_merge(request) runs in the confirming transaction and uses the request once (use_approval), so no role can merge without the two
--      people. It locks both logins, refuses an open services case or an open report (as target or reporter) on either, moves the dropped account's rows
--      to the kept one (the kept account's own rows always win a clash; the clashing dropped rows go with the erase), erases the dropped account through
--      erase_candidate (its storage keys returned for removal, less any a moved row still points to), tells the kept account (one notice and one email,
--      placeholder wording, no params) and writes one audit row naming both ids and both staff members. The audit row is written after the erase, so the
--      erase's pseudonymising leaves it as it is.
set role portal_owner;

alter table approval_request drop constraint approval_request_kind_check, add constraint approval_request_kind_check check (kind in ('threshold','critical_skills_list',
  'ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed',
  'grant_administrator','grant_role','terms_privacy_page','setting','company_seed','candidate_merge'));

create function private.candidate_merge(p_request bigint) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r approval_request; v_keep text; v_drop text; n int; moved jsonb := '{}'; res jsonb; keys jsonb;
  apps bigint[]; app_keys text[]; reqs bigint[];
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
revoke all on function private.candidate_merge(bigint) from public, anon, authenticated, service_role;
grant execute on function private.candidate_merge(bigint) to app_admin;

reset role;
