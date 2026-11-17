-- Search filters (S1, S2, #247): two index changes for the filtered job list, each measured on the full-size fill (test/perf/search.perf.ts).
-- 1. job_live_sector_sponsor: the sector browse index for the sponsor sort. 0001 gave the newest and salary sorts one (job_live_sector_newest,
--    job_live_sector_salary); 0008 added the sponsor sort, the default (#157), without one. A sector filter on the sponsor sort walked job_live_sponsor
--    and read each row for its sector: a rare sector (finance, 57 of 5,000 live jobs) read 5,200 pages, sector IT plus county Dublin 1,908.
-- 2. job_live_sponsor and job_live_newest also carry salary_low and salary_high, so the "pay stated" filter (and the pay part of the minimum pay
--    filter) is checked in the index walk: on the sponsor sort it read each row (3,387 pages, a quarter of live jobs state pay), on newest 935.
--    job_live_salary needs no change: it walks salary_sort, where the jobs that state pay come first.
set role portal_owner;

create index job_live_sector_sponsor on job(sector, (not quota_full) desc, sponsor_sort desc, posted_at desc, id desc) include (quota_full, closes_at) where status = 'live';

drop index job_live_sponsor;
create index job_live_sponsor on job((not quota_full) desc, sponsor_sort desc, posted_at desc, id desc) include (quota_full, closes_at, salary_low, salary_high) where status = 'live';
drop index job_live_newest;
create index job_live_newest on job((not quota_full) desc, posted_at desc, id desc) include (quota_full, closes_at, salary_low, salary_high) where status = 'live';

reset role;
