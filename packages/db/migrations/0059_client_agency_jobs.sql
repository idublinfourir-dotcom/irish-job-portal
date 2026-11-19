-- "Jobs posted for you by agencies" (step 15 row P11, 20b "Client is also an employer", #89): a client company sees the agency jobs that name it and
-- can press "I don't recognise this", which files a report and hides the job at once (no strike, no email to the client).
--   1. The link from an agency job to its client: job.permit_employer_name_id (set by job_defaults from the client name) to organisation_name, whose
--      organisation_id is the client company. An agency job whose client name matched no name, or a name with no company, is listed to nobody.
--   2. Reason 'not_recognised' joins the job codes (placeholder). Only private.client_not_recognised files it; the report routes do not offer it.
--   3. One open 'not_recognised' report per job (a job names one client, so this is one per job and client company).
--   4. private.client_not_recognised: an account owner of the client company; a live job is hidden in the same step with the job_hidden notice to the
--      agency's owner and the member who posted it (the same rows as trust-safety.ts HIDE_JOB); a job under review is not public, so it is only reported.
--   5. The list index: agency jobs by client name, newest first, the two states the list shows.
set role portal_owner;

alter table report drop constraint report_reason_check;
alter table report add constraint report_reason_check check (case target_kind
  when 'job' then reason in ('asks_for_money','no_sponsorship','job_closed','wrong_details','other','not_recognised')
  when 'organisation' then reason in ('fake_company','asks_for_money','no_sponsorship','other')
  else reason in ('asks_for_money','no_sponsorship','job_closed','wrong_details','other') end);

create unique index report_not_recognised_open_unique on report(target_job_id) where reason = 'not_recognised' and status in ('open','job_hidden');

create index job_client_name_idx on job(permit_employer_name_id, posted_at desc, id desc)
  where source = 'agency' and permit_employer_kind = 'client' and status in ('live','under_review');

create function private.client_not_recognised(p_user text, p_job bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user); j job; v_report bigint;
begin
  if m.role <> 'account_owner' then raise exception 'client report refused: NOT_OWNER' using errcode = 'P0001'; end if;
  select x.* into j from job x join organisation_name n on n.id = x.permit_employer_name_id
   where x.id = p_job and n.organisation_id = m.organisation_id and x.organisation_id <> m.organisation_id
     and x.source = 'agency' and x.permit_employer_kind = 'client' for update of x;
  if j.id is null then raise exception 'client report refused: JOB_NOT_FOUND' using errcode = 'P0001'; end if;
  -- a second press (any owner of the client) gets the same answer and writes nothing; the job row lock above orders two presses at once
  select id into v_report from report where target_job_id = j.id and reason = 'not_recognised' and status in ('open','job_hidden');
  if v_report is not null then return jsonb_build_object('reportId', v_report, 'hidden', j.status = 'hidden'); end if;
  if j.status not in ('live','under_review') then raise exception 'client report refused: JOB_NOT_FOUND' using errcode = 'P0001'; end if;
  insert into report(target_kind, target_job_id, reporter_portal_user_id, reason, status, target_snapshot)
    values ('job', j.id, p_user, 'not_recognised', case when j.status = 'live' then 'job_hidden' else 'open' end,
            jsonb_build_object('title', j.title, 'employer_name', j.employer_name, 'badge', j.badge, 'salary_low', j.salary_low, 'salary_high', j.salary_high,
              'pay_grade', j.pay_grade, 'closes_at', j.closes_at, 'client_organisation_id', m.organisation_id))
    returning id into v_report;
  if j.status = 'live' then
    update job set status = 'hidden', hidden_reason = 'report', hidden_report_id = v_report where id = j.id;
    with u as (select distinct mm.portal_user_id as p from membership mm where mm.organisation_id = j.organisation_id and mm.status = 'active'
                 and (mm.role = 'account_owner' or mm.id = j.posted_by_membership_id)),
         n as (insert into notification(portal_user_id, organisation_id, category, template_key, params)
                 select p, j.organisation_id, 'account', 'job_hidden', jsonb_build_object('organisationId', j.organisation_id, 'jobId', j.id) from u)
    insert into email_outbox(template, portal_user_id, params) select 'job_hidden', p, jsonb_build_object('organisationId', j.organisation_id, 'jobId', j.id) from u;
  end if;
  return jsonb_build_object('reportId', v_report, 'hidden', j.status = 'live');
end $$;
revoke all on function private.client_not_recognised(text, bigint) from public, anon, authenticated, service_role;
grant execute on function private.client_not_recognised(text, bigint) to app_portal;

reset role;
