-- The rules that decide badges, kept as whole versions in the database (step 13 part 13a; #229, #230, #234 D9).
--   1. rules_version: one row per confirmed version of one kind (the minimums, the Critical Skills list, the Ineligible list, the public pay
--      employers, the big-company names), the whole list or the minimums as jsonb, in force from effective_from until a later version of the
--      same kind starts (the later id wins on the same date). A row is only ever a confirmed version: a proposal lives in approval_request
--      (target rules_version/<kind>, change {data, effective_from}) until an administrator confirms it, and the confirm inserts the row.
--      Version 1 of each kind is the owner's seed (packages/db/src/rules-seed-cli.ts, seeded_by_owner, at most one per kind).
--      run_at: when the daily run (packages/db/src/rules-run-cli.ts) applied a minimums version (#234 D9); the seed sets it.
--   2. private.approval_check copied whole from its newest version (0012_portal_signup_terms.sql) with one new branch, rules_version, and
--      one new variable q. Nothing else changed.
--   3. private.approval_request_due copied whole from 0002_functions.sql with one more "not exists" line, so retention never deletes a request
--      a version points to.
-- Grants: every app role reads the versions (all rows are confirmed ones); app_admin inserts a version (the trigger needs the confirmed request)
-- and sets run_at. Nobody updates the data or deletes a row.
set role portal_owner;

create table rules_version(
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('minimums','critical_skills_list','ineligible_list','public_pay_employers','big_company_names')),
  data jsonb not null check (jsonb_typeof(data) in ('object','array')),
  effective_from date not null,
  approval_request_id bigint unique references approval_request(id),
  proposed_by_staff_user_id text references staff_user(id),
  seeded_by_owner boolean not null default false,
  run_at timestamptz,
  created_at timestamptz not null default now(),
  check (seeded_by_owner or approval_request_id is not null));
create index rules_version_in_force_idx on rules_version(kind, effective_from desc, id desc);
create unique index rules_version_one_seed on rules_version(kind) where seeded_by_owner;
create index rules_version_proposed_idx on rules_version(proposed_by_staff_user_id);

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
    if new.purpose in ('signup_terms','privacy_notice','portal_signup_terms') then perform private.use_approval(new.approval_request_id, 'terms_privacy_page', 'consent_text', new.purpose || ':' || new.version); end if;
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

create or replace function private.approval_request_due() returns setof bigint language sql stable security definer set search_path = public, pg_temp as $$
  select a2.id from approval_request a2 where a2.created_at < now() - interval '24 months' and a2.status <> 'pending'
      and not exists (select 1 from staff_role x where x.approval_request_id = a2.id) and not exists (select 1 from ban x where x.approval_request_id = a2.id)
      and not exists (select 1 from strike x where x.approval_request_id = a2.id) and not exists (select 1 from pay_floor x where x.approval_request_id = a2.id)
      and not exists (select 1 from sponsorship_statement x where x.approval_request_id = a2.id) and not exists (select 1 from consent_text x where x.approval_request_id = a2.id)
      and not exists (select 1 from rules_version x where x.approval_request_id = a2.id)
$$;

create trigger rules_version_approval before insert on rules_version for each row execute function private.approval_check();

grant select on rules_version to app_fetcher, app_portal, app_candidate, app_admin;
grant insert (kind, data, effective_from, approval_request_id), update (run_at) on rules_version to app_admin;

reset role;
