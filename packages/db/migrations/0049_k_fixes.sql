-- Step 15 K fixes (decisions #260, #261, #262; 19 Nov 2026). Tests: packages/db/test/rules-versions.test.ts ("the HSE switch"),
-- packages/db/test/candidate-account.test.ts ("notification settings"), packages/db/test/account-review.test.ts ("the dropped queue").
--   1. #261: the HSE becomes an entry on the public pay list ("health service executive", tier 1), ON from the start. The code
--      (packages/rules/src/employers/public-pay.ts) gives HSE names tier 1 only while the entry is in the version in force; two staff turn it off
--      through the rules route (#229) with a version without it. New databases get the entry from the owner's seed
--      (packages/fetcher/data/L2/public_employers_candidates.json). A database already seeded gets it added to the owner's seed (version 1):
--      the HSE has passed as tier 1 since that version, so this records what was already in force. A version confirmed by staff cannot be
--      changed here (its request holds the data it confirmed), so the migration refuses if one exists: add the entry through the rules route.
--   2. #260: the unused apply_reminders switch is dropped from the candidate categories; rows that chose it are deleted (they switch nothing).
--   3. #262: the dead merge_confirmation queue value is dropped from the review queue check; refused if any row uses it.
set role portal_owner;

-- ===== 1. the HSE entry
do $$ begin
  if exists (select 1 from rules_version where kind = 'public_pay_employers' and not seeded_by_owner) then
    raise exception '0049 refused: a staff-confirmed public pay version exists; add the HSE entry through the rules route' using errcode = 'P0001'; end if;
end $$;
update rules_version set data = jsonb_build_object('health service executive', jsonb_build_object('tier', 1,
    'note', 'the HSE switch (#261): matched by the name test (hse or health service executive), not by exact name')) || data
  where kind = 'public_pay_employers' and seeded_by_owner and not data ? 'health service executive';

-- ===== 2. apply_reminders
delete from notification_preference where candidate_user_id is not null and category = 'apply_reminders';
alter table notification_preference drop constraint notification_preference_candidate_category, add constraint notification_preference_candidate_category check (
  candidate_user_id is null or (category in ('job_alerts','account') and (category <> 'account' or enabled)));

-- ===== 3. merge_confirmation
do $$ begin
  if exists (select 1 from review_item where queue = 'merge_confirmation') then
    raise exception '0049 refused: review_item rows use merge_confirmation' using errcode = 'P0001'; end if;
end $$;
alter table review_item drop constraint review_item_queue_check, add constraint review_item_queue_check check (queue in ('fetched_job','account_review',
  'pay_floor_check','post_strike_job_review','scam_flag','agency_client_check','data_request','scheduled_check'));

reset role;
