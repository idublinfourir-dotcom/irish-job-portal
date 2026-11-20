-- Permit services staff board (step 15 SV-B2, decisions #256 and #272, answers S-Q9 and S-Q10 in services-plan-check.md).
--   1. private.case_event_notice (M5, S-Q9): every case_event row gives the requester one in-app notice; documents_needed, decision, closed and
--      referred also queue one short email (template case_update, no details, a sign-in link). Dedupe per event. A portal case notifies its
--      requester only, not every reader. An erased requester gets nothing. Service messages: no preference is read (#227 D3). One trigger, so
--      the staff actions (services-board.ts) and the requester's own events (SV-A) all go through it.
--   2. private.candidate_case_referral_firm and private.portal_case_referral_firm (S-Q10 B): the firm a readable case was referred to, for the
--      timeline when REFERRAL_FIRM_SHOWN is on (services-board.ts). The requester roles have no right on referral_solicitor, so this is the one door.
--   3. services_case_outcome_closed (0061) also allows referred_to_solicitor: M9 is for refused cases, and a refused case keeps its outcome when
--      it is referred.
set role portal_owner;

-- ===== 1. notices
create function private.case_event_notice() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s services_case;
begin
  select * into s from services_case where id = new.case_id;
  if s.requester_erased_at is not null or num_nonnulls(s.candidate_user_id, s.portal_user_id) = 0 then return null; end if;
  insert into notification(candidate_user_id, portal_user_id, category, template_key, params, dedupe_key)
    values (s.candidate_user_id, s.portal_user_id, 'services_case', 'case_update', jsonb_build_object('caseId', s.id::text, 'kind', new.kind), 'case_event:' || new.id)
    on conflict (dedupe_key) do nothing;
  if new.kind in ('documents_needed','decision','closed','referred') then
    insert into email_outbox(template, candidate_user_id, portal_user_id, params, dedupe_key)
      values ('case_update', s.candidate_user_id, s.portal_user_id, jsonb_build_object('caseId', s.id::text), 'case_update:' || new.id)
      on conflict (dedupe_key) do nothing;
  end if;
  return null;
end $$;
create trigger case_event_notice after insert on case_event for each row execute function private.case_event_notice();

-- ===== 2. the referral firm
create function private.case_referral_firm(p_side text, p_user text, p_case bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select r.firm from services_case s join referral_solicitor r on r.id = s.referral_solicitor_id
   where s.id = p_case and private.case_readable_by(p_side, p_user, p_case)
$$;
create function private.candidate_case_referral_firm(p_user text, p_case bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$ select private.case_referral_firm('candidate', p_user, p_case) $$;
create function private.portal_case_referral_firm(p_user text, p_case bigint) returns text
language sql stable security definer set search_path = public, pg_temp as $$ select private.case_referral_firm('portal', p_user, p_case) $$;
grant execute on function private.candidate_case_referral_firm(text, bigint) to app_candidate;
grant execute on function private.portal_case_referral_firm(text, bigint) to app_portal;

-- ===== 3. a refused case may be referred
alter table services_case drop constraint services_case_outcome_closed,
  add constraint services_case_outcome_closed check (decision_outcome is null or status <> 'closed' or close_reason in ('decided','referred_to_solicitor'));

reset role;
