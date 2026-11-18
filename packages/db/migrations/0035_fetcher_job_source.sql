-- W1c: seven Workday employers are now read from their own career sites (packages/sources/src/careers/careers.ts). The one-off move
-- (packages/db/src/workday-move-cli.ts, run as app_fetcher) re-points each saved Workday advert to the new source, and its job with it, so
-- the job keeps its id and "last checked" follows the new source. 0003 gave app_fetcher no update on job.job_source_id; this adds that one
-- column. job_guard (0019) still holds the fetcher to fetched jobs.
set role portal_owner;

grant update (job_source_id) on job to app_fetcher;

reset role;
