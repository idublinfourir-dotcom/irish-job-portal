-- Occupation pages (#223): one optional text block per occupation, written by the content side, and an index for the live jobs of one occupation.
-- content_page gets the kind 'occupation' (its slug is the four-digit occupation code). The rule "published needs source_url and checked_on" in
-- 0001 already covers every kind except help, so an occupation block needs a source and a date like a guide; that rule is not changed.
-- content_page_kind_check is copied from 0001 with one added word. The view published_content_page (0002) shows every published kind, so it needs no change.
set role portal_owner;

alter table content_page drop constraint content_page_kind_check;
alter table content_page add constraint content_page_kind_check check (kind in ('guide','update','help','occupation'));
alter table content_page add constraint content_page_occupation_slug_check check (kind <> 'occupation' or slug ~ '^[0-9]{4}$');

-- The live jobs of one occupation in the default order of the job list (sponsor history, then newest, full quota last; job_live_sponsor in 0008
-- with the occupation code in front). Before this nothing served a read by occupation_code.
create index job_live_occupation on job(occupation_code, (not quota_full) desc, sponsor_sort desc, posted_at desc, id desc) include (quota_full, closes_at) where status = 'live';

reset role;
