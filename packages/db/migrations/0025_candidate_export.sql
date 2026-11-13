-- Step 15 (the candidate data export, 20d line 154): the three sections app_candidate cannot read, through one read-only function. Nothing is replaced.
-- app_candidate has no select on audit_event and none on email_outbox's columns, and there is no row level security, so a table grant would show it every
-- person's rows. This function runs with the owner's rights and returns, for the one candidate id it is given, only:
--   emailsWeSent: email_outbox rows of that candidate, template, status and the two times (never params, dedupe_key or an address).
--   yourActionsOnTheSite: audit_event rows where that candidate is the actor, kind, action, object_type and time (never before, after or object_id).
--   whoAccessedOrReceivedYourData: audit_event kind data_access rows about that candidate, made by someone else: the organisation's display name for an
--   employer actor (every organisation the portal user belongs to), the words "Portal staff" for a staff actor (no name, no id), "Portal system" for a
--   system actor, and the time and action. Launch B writes these rows; none exist yet.
-- Trust model as claim_organisation and the other private functions: the caller's id comes from the app (its session), not from the database. Execute is
-- app_candidate only, and app_candidate gets usage on schema private for it (it could reach no other private function: none grants it execute).
set role portal_owner;

create function private.candidate_export_extras(p_candidate_user_id text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'emailsWeSent', (select coalesce(jsonb_agg(jsonb_build_object('template', e.template, 'status', e.status, 'sendAfter', e.send_after, 'sentAt', e.sent_at)
        order by e.send_after desc, e.id desc), '[]'::jsonb)
      from email_outbox e where e.candidate_user_id = p_candidate_user_id),
    'yourActionsOnTheSite', (select coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'action', a.action, 'objectType', a.object_type, 'at', a.at)
        order by a.at desc, a.id desc), '[]'::jsonb)
      from audit_event a where a.actor_candidate_user_id = p_candidate_user_id),
    'whoAccessedOrReceivedYourData', (select coalesce(jsonb_agg(jsonb_build_object('by', x.by, 'action', x.action, 'at', x.at) order by x.at desc, x.id desc), '[]'::jsonb)
      from (select a.id, a.at, a.action, case
              when a.actor_staff_user_id is not null then 'Portal staff'
              when a.actor_portal_user_id is not null then coalesce((select string_agg(distinct o.display_name, ', ' order by o.display_name)
                   from membership m join organisation o on o.id = m.organisation_id where m.portal_user_id = a.actor_portal_user_id), 'An employer')
              else 'Portal system' end as by
            from audit_event a where a.subject_candidate_user_id = p_candidate_user_id and a.kind = 'data_access'
              and a.actor_candidate_user_id is distinct from p_candidate_user_id) x)
  )
$$;

revoke all on function private.candidate_export_extras(text) from public, anon, authenticated, service_role;
grant usage on schema private to app_candidate;
grant execute on function private.candidate_export_extras(text) to app_candidate;

reset role;
