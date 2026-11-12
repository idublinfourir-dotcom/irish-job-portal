-- Employer and agency sign-up has its own terms text (#188, #194): the new consent purpose portal_signup_terms.
-- It follows the same rule as signup_terms and privacy_notice: a row needs a confirmed two-person terms_privacy_page request (target
-- consent_text, "portal_signup_terms:<version>"). Two CHECK rules list the purposes; the approval function's consent_text branch gets the
-- new one. The rest of the approval function is the text 0002 made, unchanged.
set role portal_owner;

alter table consent_text drop constraint consent_text_purpose_check;
alter table consent_text add constraint consent_text_purpose_check
  check (purpose in ('signup_terms','portal_signup_terms','privacy_notice','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor'));
alter table consent_text drop constraint consent_text_check;
alter table consent_text add constraint consent_text_check
  check (approval_request_id is null or purpose in ('signup_terms','portal_signup_terms','privacy_notice'));

create or replace function private.approval_check() returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare s strike; at timestamptz;
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
    if new.purpose in ('signup_terms','privacy_notice','portal_signup_terms') then perform private.use_approval(new.approval_request_id, 'terms_privacy_page', 'consent_text', new.purpose || ':' || new.version); end if;
  when 'organisation' then
    if new.is_big_company and (tg_op = 'INSERT' or not old.is_big_company) then perform private.use_approval(null, 'big_company_entry', 'organisation', new.id::text); end if;
  end case;
  return new;
end $$;

reset role;
