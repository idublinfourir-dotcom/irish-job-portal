-- Audit DEP-5 (27 Nov 2026): an `alter table` that waits behind the 6-hourly dump blocks everything queued behind it. portal_owner sessions now give up
-- after 5 seconds instead of waiting for ever, so a stuck migration fails fast. Role settings apply at the next login of the role.
alter role portal_owner set lock_timeout = '5s';

-- Audit OPS-5: the staff digest counts rows left `sending` for over an hour and rows `failed` in the last 7 days. Two tiny partial indexes (nearly empty
-- in normal running) keep those counts off the 100,000-row record index. A row is only `sending` between its claim and its result, so send_after ages it.
create index email_outbox_sending_idx on email_outbox(send_after) where status = 'sending';
create index email_outbox_failed_idx on email_outbox((coalesce(sent_at, send_after))) where status = 'failed';
