-- Agency licence lapse (step 15 row P9, #278): when a WRC list import no longer lists an agency's licence (missing from two lists in a row, the
-- 0014 rule), importWrc moves the agency to needs_info and puts each of its live jobs in front of staff. This migration adds the staff queue for
-- those jobs: licence_lapse_job (account_reviewer, job-queues.ts), and drops an open item of it when its job closes, as 0028 does for the other
-- job queues. The job stays live meanwhile; approve keeps it, reject closes it as removed.
set role portal_owner;

alter table review_item drop constraint review_item_queue_check, add constraint review_item_queue_check check (queue in ('fetched_job','account_review',
  'pay_floor_check','post_strike_job_review','scam_flag','agency_client_check','data_request','scheduled_check','licence_lapse_job'));

create function private.drop_lapse_items() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update review_item set status = 'dropped', outcome = 'job_closed', decided_at = now()
   where job_id = new.id and queue = 'licence_lapse_job' and status in ('open','claimed');
  return null;
end $$;
revoke all on function private.drop_lapse_items() from public, anon, authenticated, service_role;
create trigger job_drop_lapse_items after update of status on job for each row when (new.status = 'closed' and old.status <> 'closed')
  execute function private.drop_lapse_items();

reset role;
