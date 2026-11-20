-- Step 15 SV-A: the requester side of permit services (M1 requests, M2 tracker; answers S-Q1 B, S-Q2 A in services-plan-check.md).
--   1. candidate_services_case and portal_services_case (0002 `select *`, expanded to 0001's columns) are recreated with the same `select *`, so
--      0061's columns (decision_outcome, documents_needed, referral_solicitor_id) read through. create or replace appends the new columns and keeps
--      security_barrier, the cascaded check option and the 0003 grants.
--   2. Withdraw: the requester roles have no update on services_case (0003), so one security definer function per side closes an open case as
--      withdrawn and writes the withdrawn event in the same transaction. A case the login cannot read is NOT_FOUND; a portal reader who is not the
--      requester (an Owner or Recruiter of the company) is NOT_REQUESTER; a closed case, or one with a decision outcome, is NOT_OPEN.
set role portal_owner;

create or replace view candidate_services_case with (security_barrier) as select * from services_case where candidate_user_id is not null with cascaded check option;
create or replace view portal_services_case with (security_barrier) as select * from services_case where portal_user_id is not null with cascaded check option;

create function private.candidate_case_withdraw(p_user text, p_case bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(private.candidate_case_readable(p_user, p_case), false) then raise exception 'case withdraw refused: NOT_FOUND' using errcode = 'P0001'; end if;
  update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = p_case and status <> 'closed' and decision_outcome is null;
  if not found then raise exception 'case withdraw refused: NOT_OPEN' using errcode = 'P0001'; end if;
  insert into case_event(case_id, kind, status, candidate_user_id) values (p_case, 'withdrawn', 'closed', p_user);
end $$;
create function private.portal_case_withdraw(p_user text, p_case bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not coalesce(private.portal_case_readable(p_user, p_case), false) then raise exception 'case withdraw refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if not exists (select 1 from services_case where id = p_case and portal_user_id = p_user) then
    raise exception 'case withdraw refused: NOT_REQUESTER only the requester withdraws' using errcode = 'P0001'; end if;
  update services_case set status = 'closed', closed_at = now(), close_reason = 'withdrawn' where id = p_case and status <> 'closed' and decision_outcome is null;
  if not found then raise exception 'case withdraw refused: NOT_OPEN' using errcode = 'P0001'; end if;
  insert into case_event(case_id, kind, status, portal_user_id) values (p_case, 'withdrawn', 'closed', p_user);
end $$;
grant execute on function private.candidate_case_withdraw(text, bigint) to app_candidate;
grant execute on function private.portal_case_withdraw(text, bigint) to app_portal;

reset role;
