-- Runs when Launch B starts (#78). Not in the migration journal.
alter table job drop constraint job_application_route_check1;
alter table candidate_profile drop constraint candidate_profile_visible_to_employers_check;
grant select, insert on application to app_candidate;
grant update (status, withdrawn_at) on application to app_candidate;
grant select (id, job_id, organisation_id, status, cover_note, answers, profile_summary, cv_storage_key, cv_file_name, withdrawn_at, created_at) on application to app_portal;
grant select on application to app_admin;
grant select, update (status, answered_at, released_details, consent_record_id) on contact_request to app_candidate;
grant select, insert (organisation_id, membership_id, candidate_user_id) on contact_request to app_portal;
grant select on contact_request to app_admin;
grant select, insert on message to app_candidate, app_portal;
grant select on message to app_admin;
grant select, insert, delete on candidate_hidden_organisation to app_candidate;
grant insert (visible_to_employers, visible_fields), update (visible_to_employers, visible_fields) on candidate_profile to app_candidate;
grant execute on function private.move_application(bigint, text, bigint), private.search_visible_candidates(bigint, jsonb, bigint) to app_portal;
update feature_flag set enabled = true, set_by = 'named person', set_at = now();
