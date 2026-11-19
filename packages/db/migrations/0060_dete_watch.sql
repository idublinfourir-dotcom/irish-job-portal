-- Step 15 D5: the weekly DETE watcher (packages/db/src/dete-watch-cli.ts, run as app_admin from weekly-registers.yml). One row per watched
-- address: a page's main text hash or a Word file's byte hash (null until a first good fetch), a page's item titles (plain text, cut by the
-- command), when it was last checked and last changed, and the failed runs in a row with the start of that streak. A change, or 2 failed runs
-- in a row, writes a scheduled_check review item; nothing here changes the rules. Tests: packages/db/test/dete-watch.test.ts.
set role portal_owner;

create table dete_watch(
  address text primary key check (address like 'https://enterprise.gov.ie/%' and length(address) <= 300),
  fingerprint text check (length(fingerprint) between 1 and 200),
  titles jsonb not null default '[]' check (jsonb_typeof(titles) = 'array' and jsonb_array_length(titles) <= 200 and length(titles::text) <= 60000),
  checked_at timestamptz not null default now(),
  changed_at timestamptz not null default now(),
  failed_runs integer not null default 0 check (failed_runs >= 0),
  failing_since timestamptz,
  check ((failed_runs = 0) = (failing_since is null)));
grant select, insert, update on dete_watch to app_admin;

reset role;
