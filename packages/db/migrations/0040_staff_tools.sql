-- Step 15 small wave 3 (audit rows Q3, Q14). Tests: packages/db/test/staff-tools.test.ts.
set role portal_owner;

-- Q3: the daily reminders (scheduled-checks-cli.ts) write one scheduled_check item per key, and the key names its period ("dete_notice:2026-W47"),
-- so a second run on the same day, or any later day of the same period, writes nothing. Done or dropped items keep their key.
create unique index review_item_scheduled_key_unique on review_item((detail->>'key')) where queue = 'scheduled_check';

-- Q14: the company seed (the brand list: companies with their brand and DETE names, company-seed.ts) through the two-person rule from the panel:
-- a rules data editor proposes a file (approval_request target organisation/company_seed, the parsed rows in change), an administrator who did
-- not propose confirms and the seed runs in the same transaction. approval_request_guard already needs an administrator to confirm any kind but the strike ones.
alter table approval_request drop constraint approval_request_kind_check, add constraint approval_request_kind_check check (kind in ('threshold','critical_skills_list',
  'ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed',
  'grant_administrator','grant_role','terms_privacy_page','setting','company_seed'));

reset role;
