-- Step 16 backend wave 3, agent bk1 (B69): a staff note on a trust and safety case (frame 65-D08 "Add note"). Staff text only: it is read in the case panel and
-- never goes into a notice, an email or an audit row (audit rows keep codes only, #182). Written and read by app_admin (the trust_and_safety check is in
-- src/trust-safety.ts). Tests: packages/db/test/trust-board.test.ts.
set role portal_owner;

create table strike_note(
  id bigint generated always as identity primary key,
  strike_id bigint not null references strike(id),
  author_staff_user_id text not null references staff_user(id),
  body text not null check (length(body) between 1 and 5000),
  created_at timestamptz not null default now());
create index strike_note_strike_idx on strike_note(strike_id, id);
create index strike_note_author_idx on strike_note(author_staff_user_id);
grant select, insert on strike_note to app_admin;

reset role;
