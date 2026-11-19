-- Public pay scales as a sixth rules kind (#269, #67; step 15 slice S7). A version of pay_scales is the whole list of grades (code, title, first and
-- last point in euro a year, source link and page), in force from its date, proposed by a rules data editor and confirmed by an administrator
-- through /api/rules, as the other five kinds. The approval_check rules_version branch (0021) already maps any other kind to a request of the
-- same name, so only the two kind lists change. No version is seeded: the first one goes through the two-person route.
-- A renewal whose stated pay is off its listed grade's scale goes Under review with the new reason PAY_NOT_ON_SCALE (job.under_review_reason, 0045).
set role portal_owner;

alter table rules_version drop constraint rules_version_kind_check, add constraint rules_version_kind_check check (kind in ('minimums','critical_skills_list',
  'ineligible_list','public_pay_employers','big_company_names','pay_scales'));

alter table approval_request drop constraint approval_request_kind_check, add constraint approval_request_kind_check check (kind in ('threshold','critical_skills_list',
  'ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed',
  'grant_administrator','grant_role','terms_privacy_page','setting','company_seed','candidate_merge','data_request_erase','pay_scales'));

alter table job drop constraint job_under_review_reason_check, add constraint job_under_review_reason_check check (under_review_reason in ('pay_check',
  'GENERAL_RULES_NOT_SET', 'OCCUPATION_INELIGIBLE', 'QUOTA_FULL', 'OCCUPATION_NOT_ON_LIST', 'CONTRACT_TOO_SHORT', 'RULES_FAILED', 'PAY_REQUIRED', 'PAY_BELOW_MINIMUM',
  'STATEMENT_REQUIRED', 'NEEDS_REVIEW', 'PAY_NOT_ON_SCALE'));

reset role;
