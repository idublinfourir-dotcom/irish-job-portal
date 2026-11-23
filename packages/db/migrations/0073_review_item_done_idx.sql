-- Step 16 B61: the account review page's Approved and Rejected tabs list decided items newest decision first and show how many there are. Every decided item of every
-- queue shares review_item, so without an index the list walks all of them and the counts read the whole table (6,147 pages on 3,000 decided items; see
-- packages/db/test/staff-step16-c2.test.ts). One partial index on the queue, the outcome and the same sort key the list uses serves both, and the count can run from the index alone.
set role portal_owner;

create index review_item_done_queue_idx on review_item(queue, outcome, (coalesce(decided_at, created_at)) desc, id desc) where status = 'done';

reset role;
