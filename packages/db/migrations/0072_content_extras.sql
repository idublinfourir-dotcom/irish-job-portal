-- Step 16 round 2 (B15, B17, B19, B20, decisions #290 and #291): content and legal text additions.
--   1. content_page.category: an update's type (salary_minimums, quotas, occupation_lists, processing, the chips of the updates feed) or a help page's group
--      (report_problem, permit_services, jobs_badges, account, the cards of the help page). Null for guides and occupation texts. One check holds the pairs.
--   2. content_page.effective_from: the day an update's rule starts (checked_on is when we checked the source). Updates only.
--   3. content_page kind `notice` (#291): a short notice staff switch on and off through the content editor (published = on, withdrawn = off). Like help,
--      a notice needs no source and no checked-on date to be published, so content_page_check is rewritten with it.
--   4. published_content_page shows the two new columns (added last, so create or replace view keeps its grants).
--   5. consent_text purposes cookie_policy, employer_acceptable_use and data_retention (B20, #290): the two purpose checks list them, and
--      private.approval_check is copied whole from its newest version (0021_rules_versions.sql) with those purposes added to the consent_text branch,
--      so the database stays the last guard of the two-person rule for them.
set role portal_owner;

alter table content_page add column category text, add column effective_from date;
alter table content_page drop constraint content_page_kind_check;
alter table content_page add constraint content_page_kind_check check (kind in ('guide','update','help','occupation','notice'));
alter table content_page drop constraint content_page_check;
alter table content_page add constraint content_page_check check (status <> 'published' or kind in ('help','notice') or (source_url is not null and checked_on is not null));
alter table content_page add constraint content_page_category_check check (category is null
  or (kind = 'update' and category in ('salary_minimums','quotas','occupation_lists','processing'))
  or (kind = 'help' and category in ('report_problem','permit_services','jobs_badges','account')));
alter table content_page add constraint content_page_effective_check check (effective_from is null or kind = 'update');

create or replace view published_content_page with (security_barrier) as
  select id, kind, slug, title, body, source_url, checked_on, published_at, updated_at, category, effective_from from content_page where status = 'published' with cascaded check option;

alter table consent_text drop constraint consent_text_purpose_check;
alter table consent_text add constraint consent_text_purpose_check
  check (purpose in ('signup_terms','portal_signup_terms','privacy_notice','cookie_policy','employer_acceptable_use','data_retention','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor'));
alter table consent_text drop constraint consent_text_check;
alter table consent_text add constraint consent_text_check
  check (approval_request_id is null or purpose in ('signup_terms','portal_signup_terms','privacy_notice','cookie_policy','employer_acceptable_use','data_retention'));

create or replace function private.approval_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s strike; at timestamptz; q approval_request;
begin
  case tg_table_name
  when 'staff_role' then
    -- every role needs a confirmed request unless the owner seeded it (#136 c)
    if tg_op = 'INSERT' and not new.seeded_by_owner then
      perform private.use_approval(new.approval_request_id, case when new.role = 'administrator' then 'grant_administrator' else 'grant_role' end,
                                   'staff_role', new.staff_user_id, case when new.role = 'administrator' then null else new.role end); end if;
  when 'ban' then
    if tg_op = 'UPDATE' then raise exception 'ban: no role updates a ban row; a correction is a confirmed ban_lift and a new case' using errcode = 'P0001'; end if;
    if tg_op = 'DELETE' then
      perform private.use_approval(null, 'ban_lift', 'ban', old.id::text);
      update strike set ban_lifted_at = now() where id = old.strike_id;
      return old;
    end if;
    -- a ban shares its strike case's request: it is checked once, on the strike row; here it must be that request, applied in this transaction
    select * into s from strike where id = new.strike_id;
    if s.id is null or not (s.outcome = 'ban' or (s.outcome = 'strike' and s.level = 3)) then
      raise exception 'ban refused: the case must have outcome ban or level 3' using errcode = 'P0001'; end if;
    if new.approval_request_id is distinct from s.approval_request_id then
      raise exception 'ban refused: it must use the strike case''s approval request' using errcode = 'P0001'; end if;
    select applied_at into at from approval_request where id = new.approval_request_id;
    if at is distinct from now() then raise exception 'ban refused: the request was not applied in this transaction' using errcode = 'P0001'; end if;
  when 'strike' then
    if ((new.outcome = 'strike' and new.level in (2,3)) or new.outcome = 'ban') and (tg_op = 'INSERT' or old.outcome is distinct from new.outcome
        or old.level is distinct from new.level or old.approval_request_id is distinct from new.approval_request_id) then
      perform private.use_approval(new.approval_request_id, case when new.outcome = 'ban' then 'ban' when new.level = 2 then 'strike_2' else 'strike_3' end, 'strike', new.id::text);
    end if;
  when 'pay_floor' then
    if new.status = 'active' and (tg_op = 'INSERT' or old.status <> 'active' or old.approval_request_id is distinct from new.approval_request_id) then
      perform private.use_approval(new.approval_request_id, 'pay_floor', 'pay_floor', new.id::text); end if;
  when 'sponsorship_statement' then
    if new.kind = 'admin_on_behalf' then perform private.use_approval(new.approval_request_id, 'manual_post_sponsor_confirmed', 'sponsorship_statement', new.job_id::text); end if;
  when 'consent_text' then
    if new.purpose in ('signup_terms','privacy_notice','portal_signup_terms','cookie_policy','employer_acceptable_use','data_retention') then perform private.use_approval(new.approval_request_id, 'terms_privacy_page', 'consent_text', new.purpose || ':' || new.version); end if;
  when 'organisation' then
    if new.is_big_company and (tg_op = 'INSERT' or not old.is_big_company) then perform private.use_approval(null, 'big_company_entry', 'organisation', new.id::text); end if;
  when 'rules_version' then
    -- 0021 (#229): a version needs a confirmed request of its kind for this rules kind, whose change is exactly this row's data and date,
    -- and a date that is not in the past; the owner's seed (version 1) needs none. The proposer is copied from the request.
    if not new.seeded_by_owner then
      if new.effective_from < current_date then raise exception 'rules version refused: effective_from is in the past' using errcode = 'P0001'; end if;
      new.approval_request_id := private.use_approval(new.approval_request_id, case new.kind when 'minimums' then 'threshold' when 'public_pay_employers' then 'public_pay_employer'
        when 'big_company_names' then 'big_company_entry' else new.kind end, 'rules_version', new.kind);
      select * into q from approval_request where id = new.approval_request_id;
      if q.change->'data' is distinct from new.data or q.change->>'effective_from' is distinct from new.effective_from::text then
        raise exception 'rules version refused: the row is not the change the request confirmed' using errcode = 'P0001'; end if;
      new.proposed_by_staff_user_id := q.proposed_by_staff_user_id;
    end if;
  end case;
  return new;
end $$;

reset role;
