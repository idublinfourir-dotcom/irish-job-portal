-- Report a company (step 15 row S11, #102): the candidate and portal logins may file a report on a company as well as on a job.
--   1. Reasons: 'fake_company' joins the codes; a job report takes the job codes, a company report the company codes (report.ts REPORT_REASONS and
--      COMPANY_REASONS hold the same two lists). Placeholder codes until the page wording is settled.
--   2. Grants: app_candidate and app_portal may also insert target_organisation_id (0015 left them target_job_id only).
--   3. Duplicates: one open report per login and company, as per login and job (report_candidate_open_unique, report_portal_open_unique).
--   4. Merges (#234 D1): private.merge_organisations (0022 text, lines marked 0056 added) refuses a merge while the absorbed company has an open
--      company report (OPEN_REPORTS), and moves its decided company reports and its strike cases to the survivor, ids in the audit row.
--      strike_guard (0002 text, one rule changed) lets a case move only to the company its own company was merged into.
-- The staff alert (report_staff_alert, 0053) fires on every report insert, so it covers company reports with no change. A report never hides the
-- company or its jobs: only a staff decision does (K3).
set role portal_owner;

alter table report drop constraint report_reason_check;
alter table report add constraint report_reason_check check (case target_kind
  when 'job' then reason in ('asks_for_money','no_sponsorship','job_closed','wrong_details','other')
  when 'organisation' then reason in ('fake_company','asks_for_money','no_sponsorship','other')
  else reason in ('asks_for_money','no_sponsorship','job_closed','wrong_details','other') end);

grant insert (target_organisation_id) on report to app_candidate, app_portal;

create unique index report_candidate_org_open_unique on report(reporter_candidate_user_id, target_organisation_id) where status in ('open','job_hidden');
create unique index report_portal_org_open_unique on report(reporter_portal_user_id, target_organisation_id) where status in ('open','job_hidden');

create or replace function private.merge_organisations(p_staff text, p_absorbed bigint, p_survivor bigint) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a organisation; s organisation; v_names bigint[]; v_jobs bigint[]; v_posted jsonb; v_hist_before text; v_hist text; v_reports bigint[]; v_strikes bigint[];
begin
  perform private.companies_staff_check(p_staff, array['account_reviewer','fetched_job_reviewer'], 'NOT_COMPANY_STAFF');
  if p_absorbed is null or p_survivor is null then raise exception 'merge refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if p_absorbed = p_survivor then raise exception 'merge refused: SAME_COMPANY a company cannot be merged into itself' using errcode = 'P0001'; end if;
  perform 1 from organisation where id in (p_absorbed, p_survivor) order by id for update; -- both rows, lowest id first: two merges cannot deadlock
  select * into a from organisation where id = p_absorbed;
  select * into s from organisation where id = p_survivor;
  if a.id is null or s.id is null then raise exception 'merge refused: NOT_FOUND' using errcode = 'P0001'; end if;
  if a.merged_into_id is not null then raise exception 'merge refused: ALREADY_MERGED the absorbed company was merged already' using errcode = 'P0001'; end if;
  if s.merged_into_id is not null then raise exception 'merge refused: TARGET_MERGED the surviving company was merged into another company' using errcode = 'P0001'; end if;
  if a.status in ('rejected','closed','banned','suspended') or s.status in ('rejected','closed','banned','suspended') then
    raise exception 'merge refused: NOT_MERGEABLE a rejected, closed, banned or suspended company is not merged' using errcode = 'P0001'; end if;
  if a.kind <> s.kind then raise exception 'merge refused: KIND_MISMATCH the two companies are not the same kind' using errcode = 'P0001'; end if;
  if exists (select 1 from membership where organisation_id = a.id and status = 'active') then
    raise exception 'merge refused: ACTIVE_MEMBERS the absorbed company still has active members' using errcode = 'P0001'; end if;
  if exists (select 1 from application where organisation_id = a.id) then
    raise exception 'merge refused: HAS_APPLICATIONS the absorbed company has applications' using errcode = 'P0001'; end if;
  -- 0056 (S11): staff decide the absorbed company's open company reports first
  if exists (select 1 from report where target_organisation_id = a.id and status = 'open') then
    raise exception 'merge refused: OPEN_REPORTS the absorbed company has open reports: decide them first' using errcode = 'P0001'; end if;
  update organisation set merged_into_id = s.id where id = a.id;
  select coalesce(array_agg(id order by id), '{}') into v_names from organisation_name where organisation_id = a.id;
  update organisation_name set organisation_id = s.id where organisation_id = a.id;
  v_hist_before := s.permit_history;
  perform private.refresh_permit_history(); -- 0008: the one rule for the label and the sponsor sort, now over the moved names (and their DETE links)
  select permit_history into v_hist from organisation where id = s.id;
  select coalesce(array_agg(id order by id), '{}'), coalesce(jsonb_object_agg(id::text, posted_by_membership_id) filter (where posted_by_membership_id is not null), '{}')
    into v_jobs, v_posted from job where organisation_id = a.id;
  update job set organisation_id = s.id, posted_by_membership_id = null, permit_history = v_hist where organisation_id = a.id;
  -- 0056 (S11): the decided company reports and the strike cases follow the company, so its history and strike count do
  with m as (update report set target_organisation_id = s.id where target_organisation_id = a.id returning id) select coalesce(array_agg(id order by id), '{}') into v_reports from m;
  with m as (update strike set organisation_id = s.id where organisation_id = a.id returning id) select coalesce(array_agg(id order by id), '{}') into v_strikes from m;
  insert into audit_event(kind, actor_staff_user_id, action, object_type, object_id, changed_columns, before, after, source)
    values ('admin_action', p_staff, 'organisation.merge', 'organisation', a.id::text, '{merged_into_id}',
            jsonb_build_object('merged_into_id', null, 'survivor_permit_history', v_hist_before),
            jsonb_build_object('merged_into_id', s.id, 'name_ids', to_jsonb(v_names), 'job_ids', to_jsonb(v_jobs), 'job_posted_by_membership', v_posted, 'survivor_permit_history', v_hist,
                               'report_ids', to_jsonb(v_reports), 'strike_ids', to_jsonb(v_strikes)),
            'panel');
  return jsonb_build_object('absorbed', a.id, 'survivor', s.id, 'names', cardinality(v_names), 'jobs', cardinality(v_jobs));
end $$;

create or replace function private.strike_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare staff text := nullif(current_setting('app.staff_user_id', true), ''); grace integer; ok boolean; due timestamptz;
begin
  if current_user = 'app_admin' and (staff is null or not exists (select 1 from staff_user u where u.id = staff and u.status = 'active')) then
    raise exception 'strike: no acting staff member (set local app.staff_user_id to an active staff user)' using errcode = 'P0001'; end if;
  if tg_op = 'INSERT' then
    if new.outcome is not null or new.level is not null then new.decided_by_staff_user_id := staff; new.decided_at := now(); end if;
    if current_user = 'app_admin' then
      if new.reply_due_at > now() + interval '7 days' then raise exception 'strike: reply_due_at is at most 7 days from now' using errcode = 'P0001'; end if;
      if new.appeal_due_at > coalesce(new.decided_at, now()) + interval '7 days' then raise exception 'strike: appeal_due_at is at most 7 days after the decision' using errcode = 'P0001'; end if;
    end if;
    return new;
  end if;
  -- 0056 (S11): only a merge moves a case, to the company its own was merged into
  if new.organisation_id is distinct from old.organisation_id
     and not exists (select 1 from organisation o where o.id = old.organisation_id and o.merged_into_id = new.organisation_id) then
    raise exception 'strike: the organisation of a case never changes' using errcode = 'P0001'; end if;
  if old.stage in ('upheld','overturned') and new.stage is distinct from old.stage then raise exception 'strike: stage never moves out of upheld or overturned' using errcode = 'P0001'; end if;
  if old.appeal_decided_at is not null and (new.outcome is distinct from old.outcome or new.level is distinct from old.level) then
    raise exception 'strike: outcome and level are frozen once the appeal is decided' using errcode = 'P0001'; end if;
  if new.outcome is distinct from old.outcome or new.level is distinct from old.level then new.decided_by_staff_user_id := staff; new.decided_at := now(); end if;
  -- deadlines: set once, within 7 days of the notice or decision; no role moves one afterwards (staff could otherwise let a late reply or appeal in)
  if current_user = 'app_admin' then
    if old.reply_due_at is not null and new.reply_due_at is distinct from old.reply_due_at then raise exception 'strike: reply_due_at never changes once set' using errcode = 'P0001'; end if;
    if old.appeal_due_at is not null and new.appeal_due_at is distinct from old.appeal_due_at then raise exception 'strike: appeal_due_at never changes once set' using errcode = 'P0001'; end if;
    if new.reply_due_at is distinct from old.reply_due_at and new.reply_due_at > now() + interval '7 days' then raise exception 'strike: reply_due_at is at most 7 days from now' using errcode = 'P0001'; end if;
    if new.appeal_due_at is distinct from old.appeal_due_at and new.appeal_due_at > coalesce(new.decided_at, now()) + interval '7 days' then raise exception 'strike: appeal_due_at is at most 7 days after the decision' using errcode = 'P0001'; end if;
  end if;
  if new.stage is distinct from old.stage and new.stage in ('upheld','overturned') then new.appeal_decided_by_staff_user_id := staff; new.appeal_decided_at := now(); end if;
  if current_user = 'app_admin' then select value into grace from setting where key = 'staff_entry_grace'; end if;
  -- reply
  if new.employer_reply is distinct from old.employer_reply then
    if old.decided_at is not null then raise exception 'strike: the case is decided, no reply' using errcode = 'P0001'; end if;
    due := old.reply_due_at;
    if current_user = 'app_portal' then ok := now() <= due; new.reply_received_at := null; new.reply_entered_by_staff_user_id := null;
    elsif current_user = 'app_admin' then
      ok := new.reply_received_at is not null and new.reply_received_at <= due and new.reply_received_at <= now() and now() <= due + make_interval(days => coalesce(grace, 0));
      new.reply_entered_by_staff_user_id := staff;
    else ok := true; end if;
    if not coalesce(ok, false) then raise exception 'strike: the reply window is closed or not open' using errcode = 'P0001'; end if;
    new.replied_at := now();
  elsif new.reply_received_at is distinct from old.reply_received_at then
    raise exception 'strike: a received date changes only in the same update as its text' using errcode = 'P0001';
  end if;
  -- appeal
  if new.appeal_text is distinct from old.appeal_text then
    if old.appeal_decided_at is not null then raise exception 'strike: the appeal is decided, no new appeal' using errcode = 'P0001'; end if;
    due := old.appeal_due_at;
    if current_user = 'app_portal' then ok := now() <= due; new.appeal_received_at := null; new.appeal_entered_by_staff_user_id := null;
    elsif current_user = 'app_admin' then
      ok := new.appeal_received_at is not null and new.appeal_received_at <= due and new.appeal_received_at <= now() and now() <= due + make_interval(days => coalesce(grace, 0));
      new.appeal_entered_by_staff_user_id := staff;
    else ok := true; end if;
    if not coalesce(ok, false) then raise exception 'strike: the appeal window is closed or not open' using errcode = 'P0001'; end if;
    new.appealed_at := now();
  elsif new.appeal_received_at is distinct from old.appeal_received_at then
    raise exception 'strike: a received date changes only in the same update as its text' using errcode = 'P0001';
  end if;
  return new;
end $function$;

reset role;
