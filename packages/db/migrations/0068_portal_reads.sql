-- Step 16 backend round 1, agent p1 (B47, B49):
--   1. private.verification_status (B47, frame E06): what the verification page shows an account owner or member of a company waiting for review: the
--      email check, the CRO register row, whether the company name is in the DETE permit names, when the review item opened, and the newest "ask for more"
--      question (the owner only; it was written for the owner). review_item and notification are not readable by app_portal, so this is a security-definer read.
--   2. private.portal_jobs (0045's text) adds permitType, applicationRoute and hasOwnPage (a flag, never the address) to every job of the list (B49).
--   3. job_check1 (the own page rule of 0001) lets a draft have no own page address yet, so "Save draft" needs only a title (B49). A job that is not a
--      draft still needs it; the portal's live post body requires it too.
set role portal_owner;

create function private.verification_status(p_user text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user);
begin
  return (select jsonb_build_object(
    'organisationId', o.id, 'status', o.status,
    'emailVerified', (select u.email_verified from portal_user u where u.id = p_user),
    'croNumber', o.cro_number,
    'croFound', case when o.cro_number is null then null else exists (select 1 from cro_company c where c.cro_number = o.cro_number) end,
    'croName', (select c.name from cro_company c where c.cro_number = o.cro_number),
    'croStatus', (select c.status from cro_company c where c.cro_number = o.cro_number),
    'deteMatch', exists (select 1 from organisation_name n where n.organisation_id = o.id and n.source = 'dete'),
    'reviewOpenedAt', (select r.created_at from review_item r where r.queue = 'account_review' and r.organisation_id = o.id and r.status in ('open','claimed')),
    'question', case when m.role = 'account_owner' and o.status = 'needs_info' then
      (select n.params->>'question' from notification n where n.portal_user_id = p_user and n.template_key = 'account_needs_info' order by n.created_at desc, n.id desc limit 1) end)
    from organisation o where o.id = m.organisation_id);
end $$;
grant execute on function private.verification_status(text) to app_portal;

create or replace function private.portal_jobs(p_user text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user);
begin
  return coalesce((select jsonb_agg(x.j order by x.posted_at desc, x.id desc) from (
    select j.id, j.posted_at, jsonb_build_object(
      'id', j.id, 'title', j.title, 'status', j.status, 'badge', j.badge, 'passRoute', j.pass_route, 'occupationCode', j.occupation_code,
      'county', j.county, 'salaryLow', j.salary_low, 'salaryHigh', j.salary_high, 'payGrade', j.pay_grade, 'weeklyHours', j.weekly_hours,
      'permitType', j.permit_type, 'applicationRoute', j.application_route, 'hasOwnPage', j.own_page_url is not null,
      'postedAt', j.posted_at, 'closesAt', j.closes_at, 'closedAt', j.closed_at, 'closeReason', j.close_reason, 'hireAnswer', j.hire_answer,
      'reason', case j.status
        when 'in_review' then case when exists (select 1 from review_item r where r.job_id = j.id and r.queue = 'post_strike_job_review' and r.status in ('open','claimed'))
                                   then 'restricted_company' else 'staff_check' end
        when 'under_review' then case when j.under_review_reason = 'pay_check' then 'pay_check' else 'renewal_check' end
        when 'hidden' then j.hidden_reason end,
      'reviewCode', case when j.status = 'under_review' and j.under_review_reason <> 'pay_check' then j.under_review_reason end,
      'exceptionConfirmed', j.exception_confirmed_at is not null,
      'clientCheck', exists (select 1 from review_item r where r.job_id = j.id and r.queue = 'agency_client_check' and r.status in ('open','claimed'))) as j
    from job j where j.organisation_id = m.organisation_id and j.source in ('employer','agency')
    order by j.posted_at desc, j.id desc limit 200) x), '[]'::jsonb);
end $$;

alter table job drop constraint job_check1, add constraint job_check1 check (application_route <> 'own_page' or own_page_url is not null or status = 'draft');

reset role;
