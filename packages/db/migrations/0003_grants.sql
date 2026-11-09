-- Grants (design 23). Revokes Supabase's defaults first, then gives each app role exactly what its Access line says.
set role portal_owner;

-- Rights exactly as each table's Access line says. Launch B tables and functions get nothing.
-- Reading used here: "reads" = select; "writes" = insert and update; "full rights" = all four; delete only where an action needs it.
-- Undo Supabase's defaults (section 2: every migration revokes them; PUBLIC loses execute on every function)
revoke all on all tables in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema public, private from public, anon, authenticated, service_role;
revoke all on schema private from public;
alter default privileges for role portal_owner in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role portal_owner in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role portal_owner in schema public revoke all on sequences from anon, authenticated, service_role;
alter default privileges for role portal_owner revoke execute on functions from public;
-- PICK: the design grants execute but never says the app roles get usage on `private`; without it the grants do nothing.
grant usage on schema private to app_admin, app_portal;

-- ===== job tables
grant select (id, organisation_id, source, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge,
  salary_low, salary_high, salary_sort, health_insurance_eur, pay_grade, pass_route, quota_full, status, posted_at, closes_at, closed_at, permit_history,
  application_route, own_page_url, permit_employer_kind, permit_employer_name, job_source_id, search_vector) on job to app_candidate;
grant select (id, organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge,
  salary_low, salary_high, salary_sort, health_insurance_eur, pay_grade, pass_route, pay_floor_id, status, close_reason, posted_at, closes_at, closed_at,
  search_vector, application_route, own_page_url, route_switched_at, screening_questions, permit_employer_kind, permit_employer_name, permit_employer_name_id,
  permit_employer_check, posted_by_membership_id, hire_answer, hire_answered_at, hire_answered_by_membership_id) on job to app_portal;
grant insert (organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge,
  salary_low, salary_high, health_insurance_eur, pay_grade, pass_route, pay_floor_id, status, close_reason, closes_at, closed_at,
  search_vector, application_route, own_page_url, route_switched_at, screening_questions, permit_employer_kind, permit_employer_name, permit_employer_name_id,
  permit_employer_check, posted_by_membership_id, hire_answer, hire_answered_at, hire_answered_by_membership_id) on job to app_portal;
grant update (organisation_id, source, job_source_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge,
  salary_low, salary_high, health_insurance_eur, pay_grade, pass_route, pay_floor_id, status, close_reason, closes_at, closed_at,
  search_vector, application_route, own_page_url, route_switched_at, screening_questions, permit_employer_kind, permit_employer_name, permit_employer_name_id,
  permit_employer_check, posted_by_membership_id, hire_answer, hire_answered_at, hire_answered_by_membership_id) on job to app_portal;
-- PICK: the fetcher has no column list in the design; section 2 keeps trust columns out (permit_history, hidden_*, quota_full, posted-by, hire answer)
grant select on job to app_fetcher;
grant insert (organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, county, sector, occupation_code, contract_type, contract_months,
  permit_type, badge, salary_low, salary_high, health_insurance_eur, pass_route, status, close_reason, closes_at, closed_at, search_vector,
  application_route, own_page_url, permit_employer_kind, permit_employer_name, permit_employer_name_id, permit_employer_check) on job to app_fetcher;
grant update (title, employer_name, county, sector, occupation_code, contract_type, contract_months, permit_type, badge, salary_low, salary_high,
  health_insurance_eur, pass_route, status, close_reason, closes_at, closed_at, search_vector, own_page_url, permit_employer_kind, permit_employer_name,
  permit_employer_name_id, permit_employer_check) on job to app_fetcher;
grant select, insert, update, delete on job to app_admin;
grant select on job_text to app_candidate;
grant select, insert, update, delete on job_text to app_portal, app_fetcher, app_admin;
grant select, insert, update on job_source to app_fetcher;
grant select on job_source to app_candidate, app_portal, app_admin;
grant select, insert, update on fetched_advert to app_fetcher;
grant select on fetched_advert to app_admin;
grant update (result) on fetched_advert to app_admin; -- rejects a queued advert
grant select, insert, update on fetch_run to app_fetcher;
grant select on fetch_run to app_admin;
grant insert, update on job_daily_stat to app_candidate;
grant select (job_id, day, views, apply_clicks) on job_daily_stat to app_candidate;
grant select on job_daily_stat to app_portal, app_admin;

-- ===== candidate pool
grant select, insert on candidate_user to app_candidate;
grant update (name, email, email_verified, image, updated_at, deleted_at, last_active_at) on candidate_user to app_candidate;
grant select, insert, update, delete on candidate_session, candidate_account, candidate_verification, candidate_rate_limit to app_candidate;
grant select on candidate_user to app_admin;
grant update (suspended_at, deleted_at) on candidate_user to app_admin; -- deleted_at: the cancel of a deletion request
grant select (id, user_id), delete on candidate_session to app_admin;
grant select, delete on candidate_profile to app_candidate;
grant insert (candidate_user_id, full_name, phone, occupation_code, years_experience, has_relevant_degree, degree_field, degree_awarded_month,
  registration_body, registration_number, registration_status, location_kind, current_stamp) on candidate_profile to app_candidate;
grant update (full_name, phone, occupation_code, years_experience, has_relevant_degree, degree_field, degree_awarded_month,
  registration_body, registration_number, registration_status, location_kind, current_stamp) on candidate_profile to app_candidate;
grant select on candidate_profile to app_admin;
grant select, insert, update, delete on candidate_cv to app_candidate;
grant select on candidate_cv to app_admin;
grant select, insert, delete on saved_job to app_candidate;
grant select on saved_job to app_admin;
grant select, insert, update, delete on tracker_entry to app_candidate;
grant select, insert, update, delete on apply_click to app_candidate;
grant select on apply_click to app_admin;
grant select, insert, update, delete on alert to app_candidate;
grant select on alert to app_admin;

-- ===== portal pool and companies
grant select, insert on portal_user to app_portal;
grant update (name, email, email_verified, image, updated_at, deleted_at, last_active_at) on portal_user to app_portal;
grant select, insert, update, delete on portal_session, portal_account, portal_verification, portal_rate_limit to app_portal;
grant select on portal_user to app_admin;
grant update (status, blocked_at, blocked_reason_code, deleted_at) on portal_user to app_admin;
grant select (id, user_id), delete on portal_session to app_admin;
grant select (id, slug, display_name, website, logo_url, short_description, county, nace_code, kind, status, permit_history, claimed_at,
  claims_removed_at, wrc_licence_number, merged_into_id) on organisation to app_candidate;
grant select on organisation to app_portal;
grant update (display_name, website, logo_url, short_description, county) on organisation to app_portal;
grant select on organisation to app_fetcher;
grant insert (slug, display_name, kind, county) on organisation to app_fetcher;
grant select, insert, update on organisation to app_admin;
grant select on organisation_name to app_candidate, app_portal;
grant select, insert on organisation_name to app_fetcher;
grant select, insert, update, delete on organisation_name to app_admin;
grant select, insert, update, delete on organisation_domain to app_admin;
grant select, insert, update, delete on cro_company to app_fetcher;
grant select on cro_company to app_portal, app_admin;
grant select, insert, update, delete on dete_permit_count to app_admin;
grant select on dete_permit_count to app_candidate, app_portal, app_fetcher;
grant select, insert, update, delete on wrc_licence to app_admin;
grant select on wrc_licence to app_portal, app_fetcher;
grant select, insert, update on membership to app_portal, app_admin;
grant select, insert on sponsorship_statement to app_portal, app_admin;
grant update (superseded_at) on sponsorship_statement to app_portal, app_admin;
grant select, insert on pay_floor to app_portal;
grant update (status) on pay_floor to app_portal;
grant select, update on pay_floor to app_admin;
grant select (id, organisation_id, role_family, floor_eur, valid_until, status) on pay_floor to app_fetcher;

-- ===== staff
grant select, insert, update, delete on staff_user, staff_session, staff_account, staff_verification, staff_rate_limit to app_admin;
grant select, delete on staff_role to app_admin;
grant insert (staff_user_id, role, granted_by_staff_user_id, approval_request_id) on staff_role to app_admin;

-- ===== services: tables shut to candidate and portal, views of their own side
grant select, insert, update on services_case to app_admin;
grant select on candidate_services_case to app_candidate;
grant insert (candidate_user_id, organisation_id, job_id, permit_type, offer_details, payer, consent_record_id, employer_contact_consent_record_id) on candidate_services_case to app_candidate;
grant select on portal_services_case to app_portal;
grant insert (portal_user_id, organisation_id, job_id, permit_type, offer_details, payer, consent_record_id, employer_contact_consent_record_id, dedupe_key) on portal_services_case to app_portal;
grant select, insert, update, delete on case_note to app_admin;
grant select on case_document to app_admin;
grant insert (services_case_id, storage_key, file_name, content_type, byte_size, staff_user_id) on case_document to app_admin; -- staff upload copies too
grant update (storage_key, file_name, copy_deleted_at) on case_document to app_admin;
grant select on candidate_case_document to app_candidate;
grant insert (services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id) on candidate_case_document to app_candidate;
grant select on portal_case_document to app_portal;
grant insert (services_case_id, storage_key, file_name, content_type, byte_size, portal_user_id) on portal_case_document to app_portal;
grant select, insert, update, delete on case_quote to app_admin;
grant select (id, services_case_id, organisation_id, amount_eur, status, invoice_number, sent_at, invoiced_at, paid_at) on case_quote to app_portal;

-- ===== content and contact
grant select, insert, update on content_page to app_admin;
grant select on published_content_page to app_candidate, app_portal;
grant insert (surface, candidate_user_id, from_name, from_email, topic, body), select (id) on contact_message to app_candidate;
grant insert (surface, portal_user_id, from_name, from_email, topic, body), select (id) on contact_message to app_portal;
grant select, update on contact_message to app_admin;

-- ===== trust and safety
grant insert, select (id) on report to app_candidate, app_portal;
grant select, insert, update, delete on report to app_admin;
-- app_admin reads every strike column; its insert and update grants leave out what only the triggers set (the times and the staff ids) and ban_lifted_at.
grant select on strike to app_admin;
grant insert (organisation_id, case_kind, job_id, pay_floor_id, report_id, reason_code, notice_summary, level, stage, outcome, reply_due_at, employer_reply, reply_received_at,
  approval_request_id, appeal_due_at, appeal_text, appeal_received_at) on strike to app_admin;
grant update (organisation_id, case_kind, job_id, pay_floor_id, report_id, reason_code, notice_summary, level, stage, outcome, reply_due_at, employer_reply, reply_received_at,
  approval_request_id, appeal_due_at, appeal_text, appeal_received_at) on strike to app_admin;
-- app_portal: no report_id, approval_request_id, staff ids or received dates (PICK: the status page needs none of the received dates).
grant select (id, organisation_id, case_kind, job_id, pay_floor_id, reason_code, notice_summary, level, stage, outcome, reply_due_at, employer_reply,
  replied_at, decided_at, appeal_due_at, appeal_text, appealed_at, appeal_decided_at) on strike to app_portal;
grant update (employer_reply, appeal_text) on strike to app_portal;
grant select, insert, delete on ban to app_admin; -- no update
-- approval_request: reads; inserts only the proposal's own columns; updates only status. Triggers do the rest.
grant select on approval_request to app_admin;
grant insert (kind, target_table, target_id, change, effective_from, reason) on approval_request to app_admin;
grant update (status) on approval_request to app_admin;
grant select, insert, update on review_item to app_admin;
grant insert, select (queue, job_id, status) on review_item to app_fetcher;
grant insert on audit_event to app_candidate, app_portal, app_admin, app_fetcher;
grant select on audit_event to app_admin;

-- ===== consent and messages
grant select on consent_text to app_candidate, app_portal, app_admin;
grant insert on consent_text to app_admin;
grant select on consent_record to app_admin;
grant select on candidate_consent_record to app_candidate;
grant insert (candidate_user_id, consent_text_id, given_at, job_id, organisation_id, details), update (withdrawn_at) on candidate_consent_record to app_candidate;
grant select on portal_consent_record to app_portal;
grant insert (portal_user_id, consent_text_id, given_at, job_id, organisation_id, details), update (withdrawn_at) on portal_consent_record to app_portal;
grant select, insert, update, delete on notification_preference to app_admin;
grant select, delete on candidate_notification_preference to app_candidate;
grant insert (candidate_user_id, category, channel, enabled), update (enabled) on candidate_notification_preference to app_candidate;
grant select, delete on portal_notification_preference to app_portal;
grant insert (portal_user_id, category, channel, enabled), update (enabled) on portal_notification_preference to app_portal;
-- notification: only app_admin and app_fetcher insert into the table; the candidate and the portal write their own side through their views.
grant insert, select (dedupe_key) on notification to app_admin, app_fetcher;
grant select, update (read_at), insert (candidate_user_id, organisation_id, category, template_key, params, dedupe_key) on candidate_notification to app_candidate;
grant select, update (read_at), insert (portal_user_id, organisation_id, category, template_key, params, dedupe_key) on portal_notification to app_portal;
grant insert, select (dedupe_key) on email_outbox to app_candidate, app_portal, app_admin, app_fetcher;
grant select, update (status, attempts, sent_at) on email_outbox to app_admin;
grant select on feature_flag to app_candidate, app_portal, app_admin, app_fetcher;
grant select, insert, update on setting to app_admin;

-- ===== functions: execute only where section 2.1 says
grant execute on function private.erase_candidate(text, boolean), private.erase_portal_user(text, boolean), private.run_retention(integer) to app_admin;
grant execute on function private.claim_organisation(text, bigint), private.register_organisation(text, text, text, text, text) to app_portal;

reset role;
