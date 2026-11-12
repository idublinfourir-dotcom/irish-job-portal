-- The employer's status page (#44, #91, #134 to #136, #198, #213, 20b section 4). Until now app_portal could read the status-page columns
-- of every company's strike rows and write employer_reply and appeal_text on any of them (0003); strike_guard checks the time windows but not
-- who writes. This migration takes those grants away and gives app_portal three security definer functions instead. Each takes the acting
-- login's id (the route reads it from the session, never the body) and checks the login and its own active membership in the same call:
-- any active member reads the company's cases, only the account owner replies or appeals. A refusal raises 'status refused: CODE ...'.
--
-- strike_guard runs with the caller's rights and has an app_portal branch. These functions run as portal_owner, so that branch no longer
-- applies and the windows are checked here instead (the same rules: a reply only before reply_due_at and before the decision, an appeal only
-- before appeal_due_at and before the appeal is decided). The trigger still stamps replied_at and appealed_at.
-- PICK: one reply and one appeal per case, never rewritten, so staff never decide on words that change after they read them.
set role portal_owner;

revoke select (id, organisation_id, case_kind, job_id, pay_floor_id, reason_code, notice_summary, level, stage, outcome, reply_due_at, employer_reply,
  replied_at, decided_at, appeal_due_at, appeal_text, appealed_at, appeal_decided_at) on strike from app_portal;
revoke update (employer_reply, appeal_text) on strike from app_portal;

-- The acting login's active membership, or a refusal.
create function private.status_member(p_user text) returns membership
language plpgsql security definer set search_path = public, pg_temp as $$
declare u portal_user; m membership;
begin
  select * into u from portal_user where id = p_user;
  if u.id is null or u.status <> 'active' or u.deleted_at is not null then raise exception 'status refused: REFUSED unknown, blocked or deleted login' using errcode = 'P0001'; end if;
  select * into m from membership where portal_user_id = p_user and status = 'active';
  if m.id is null then raise exception 'status refused: NOT_A_MEMBER no active membership' using errcode = 'P0001'; end if;
  return m;
end $$;

-- The status page: the company's state, the strikes counted in the last 12 months, and every case the company has been told of (notified or
-- decided). Never the report or the reporter, the staff ids or the received dates.
create function private.status_page(p_user text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user); v_owner boolean := m.role = 'account_owner';
begin
  return (select jsonb_build_object(
    'organisationId', o.id, 'status', o.status, 'restrictedUntil', o.restricted_until, 'claimsRemovedAt', o.claims_removed_at, 'isOwner', v_owner,
    'strikesLast12Months', (select count(*) from strike s where s.organisation_id = o.id and s.outcome = 'strike' and s.stage <> 'overturned'
                              and s.decided_at > now() - interval '12 months'),
    'cases', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'caseKind', s.case_kind, 'reasonCode', s.reason_code, 'jobId', s.job_id, 'jobTitle', j.title, 'noticeSummary', s.notice_summary,
        'stage', s.stage, 'outcome', s.outcome, 'level', s.level, 'replyDueAt', s.reply_due_at, 'employerReply', s.employer_reply, 'repliedAt', s.replied_at,
        'decidedAt', s.decided_at, 'appealDueAt', s.appeal_due_at, 'appealText', s.appeal_text, 'appealedAt', s.appealed_at,
        'appealDecidedAt', s.appeal_decided_at,
        'canReply', v_owner and s.decided_at is null and s.employer_reply is null and now() <= s.reply_due_at,
        'canAppeal', v_owner and s.decided_at is not null and s.appealed_at is null and s.appeal_decided_at is null and now() <= s.appeal_due_at)
        order by s.id desc)
      from strike s left join job j on j.id = s.job_id
      where s.organisation_id = o.id and (s.reply_due_at is not null or s.decided_at is not null)), '[]'::jsonb))
    from organisation o where o.id = m.organisation_id);
end $$;

-- The owner's reply or appeal on one of its company's cases. p_kind is 'reply' or 'appeal'. Text: 1 to 1,800 characters after trimming (the route's 2,048-character body cap leaves room for the JSON around it),
-- line breaks and tabs allowed, no other control or format characters. One audit row of codes only (#182).
create function private.status_write(p_user text, p_kind text, p_case bigint, p_text text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m membership := private.status_member(p_user); s strike; v text := btrim(p_text);
begin
  if m.role <> 'account_owner' then raise exception 'status refused: NOT_OWNER only the account owner replies or appeals' using errcode = 'P0001'; end if;
  if p_kind is null or p_kind not in ('reply','appeal') then raise exception 'status refused: BAD_REQUEST kind' using errcode = 'P0001'; end if;
  if v is null or length(v) < 1 or length(v) > 1800
     or v ~ '[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb]' then
    raise exception 'status refused: BAD_TEXT' using errcode = 'P0001'; end if;
  select * into s from strike where id = p_case and organisation_id = m.organisation_id and (reply_due_at is not null or decided_at is not null) for update;
  if s.id is null then raise exception 'status refused: CASE_NOT_FOUND' using errcode = 'P0001'; end if;
  if p_kind = 'reply' then
    if s.employer_reply is not null then raise exception 'status refused: ALREADY_REPLIED' using errcode = 'P0001'; end if;
    if s.decided_at is not null or not coalesce(now() <= s.reply_due_at, false) then
      raise exception 'status refused: REPLY_CLOSED the reply window is closed or not open' using errcode = 'P0001'; end if;
    update strike set employer_reply = v where id = s.id;
  else
    if s.appealed_at is not null then raise exception 'status refused: ALREADY_APPEALED' using errcode = 'P0001'; end if;
    if s.decided_at is null or s.appeal_decided_at is not null or not coalesce(now() <= s.appeal_due_at, false) then
      raise exception 'status refused: APPEAL_CLOSED the appeal window is closed or not open' using errcode = 'P0001'; end if;
    update strike set appeal_text = v, stage = 'appealed' where id = s.id; -- the stage staff set for an appeal they enter (trust-safety.ts)
  end if;
  insert into audit_event(kind, actor_portal_user_id, action, object_type, object_id, before, after, source)
    values ('security', p_user, 'strike.' || p_kind, 'strike', s.id::text, jsonb_build_object('stage', s.stage),
            jsonb_build_object('stage', case when p_kind = 'appeal' then 'appealed' else s.stage end), 'site');
  return jsonb_build_object('caseId', s.id, 'kind', p_kind);
end $$;

grant execute on function private.status_page(text), private.status_write(text, text, bigint, text) to app_portal;

reset role;
