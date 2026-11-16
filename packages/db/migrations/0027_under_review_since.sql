-- Step 15 (#93): a job that has been under review for 30 days closes. The job needs to know when it went under review.
--   1. job.under_review_since: set by trigger when the status becomes under_review, kept while it stays there, cleared when it leaves.
--      Rows already under review get the migration time, so their 30 days start now. No app role has a grant on the column (the portal and
--      candidate roles list their columns, the fetcher's update list leaves it out); app_admin's table-wide grant is the only writer besides the trigger.
--   2. job_under_review_idx: the daily close (packages/db/src/job-expiry-cli.ts) reads only the jobs under review, oldest first.
set role portal_owner;

alter table job add column under_review_since timestamptz;
update job set under_review_since = now() where status = 'under_review';

create function private.job_under_review_since() returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  new.under_review_since := case when new.status <> 'under_review' then null
    when tg_op = 'UPDATE' and old.status = 'under_review' then old.under_review_since else now() end;
  return new;
end $$;
create trigger job_under_review_since before insert or update of status on job for each row execute function private.job_under_review_since();

create index job_under_review_idx on job(under_review_since) where status = 'under_review';

reset role;
