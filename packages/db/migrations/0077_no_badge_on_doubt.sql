-- AUTO1 (decisions #298 and #299, 25 Nov 2026): doubt means no badge, and no person is asked. From this release the fetcher queues nothing (packages/fetcher/src/plan.ts), so
-- this closes, once, the jobs it queued before: 301 on live, none ever decided by staff, 60 of them for adverts that are gone. Only a job that still is the fetcher's own:
-- fetched, in review, its advert row says "queued", its review item open (a claimed item is a staff member's; a job staff put back in review has an advert that "passed").
-- All close as recheck_failed, also the gone ones: 'closed' would open them on the public closed-job page (0075), and they were never public.
-- The text goes (#122), the review item is dropped, the advert row says "rejected" as a new doubtful advert now does. The fetcher may reopen the job when the advert passes (0035).
-- Two kinds lose their hash, so the next fetch reads them again and decides afresh: a public pay pass (stage "8 ...", bucketOf in packages/rules/src/chain/assess.ts), which
-- now goes live by itself for the HSE (#299), and a badge the model took away with no quote on the row (it named no listed occupation, or its reply could not be used: the
-- row cannot tell).
-- Run it after the release: the code before it can still queue a doubtful advert, and nothing but this migration closes one.
-- Nothing here widens a right: the job guard still refuses the fetcher any move out of in_review.
set role portal_owner;

with waiting as (
  select j.id, a.id as advert_id from job j join fetched_advert a on a.id = j.fetched_advert_id join review_item r on r.job_id = j.id and r.queue = 'fetched_job' and r.status = 'open'
  where j.source = 'fetched' and j.status = 'in_review' and a.result = 'queued'),
closed as (update job set status = 'closed', close_reason = 'recheck_failed', search_vector = null where id in (select id from waiting)),
texts as (delete from job_text where job_id in (select id from waiting)),
items as (update review_item set status = 'dropped', outcome = 'no_badge_on_doubt', decided_at = now() where job_id in (select id from waiting) and queue = 'fetched_job' and status = 'open')
update fetched_advert set result = 'rejected',
  content_hash = case when gone_at is null and (stage like '8 %' or (stage like '5 %' and matcher_model <> 'rules' and quoted_evidence is null)) then null else content_hash end
where id in (select advert_id from waiting);

reset role;
