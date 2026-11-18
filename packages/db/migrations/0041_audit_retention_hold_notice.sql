-- Step 15, audit rows R3 and R4 (small wave agent 4).
--   R3. The audit log is kept for the setting audit_event (24 months, a placeholder until the solicitor confirms it), then deleted by a new retention
--       rule 43, batched like the others. private.audit_purge (0002), never scheduled, now reads the same setting, so the two cannot disagree; an empty
--       setting deletes nothing. A change to the setting follows the two-person rule (0004), as every other period does.
--   R4. Where rules 1, 5, 6 and 8 leave a candidate's rows out because of an open services case, run_retention writes one notice and one pending email
--       (template deletion_on_hold, placeholder wording, params the rule key only) per person per rule, dedupe key deletion_on_hold:<rule>:<candidate>,
--       so later daily runs write nothing more. A frozen person who already deleted their account (rule 8) gets the email at the address in params,
--       as account_deleted does (rule 29 empties params after 30 days). An open report freezes too, but is not a case and writes nothing.
--       run_retention is 0002's text with that one block added.
set role portal_owner;

insert into setting(key, value, unit, is_guess) values ('audit_event', 24, 'months', true);

do $m$
declare
  old_sql constant text := $o$$q$with d as (delete from staff_rate_limit where id = any($2) returning 1) select count(*)::int, '{}'::text[] from d$q$, null)$o$;
  new_sql constant text := old_sql || $o$,
    (43, 'audit_event', null, $q$select id::text as id from audit_event where at < now() - make_interval(months => $1)$q$, null, 'sql',
     $q$with d as (delete from audit_event where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$q$, null)$o$;
  def text := pg_get_functiondef('private.retention_rules()'::regprocedure);
begin
  if (length(def) - length(replace(def, old_sql, ''))) <> length(old_sql) then raise exception '0041: rule 42 text not found exactly once'; end if;
  execute replace(def, old_sql, new_sql);
end $m$;

create or replace function private.audit_purge() returns bigint language plpgsql security definer set search_path = public, pg_temp as $$
declare n bigint;
begin
  delete from audit_event where at < now() - make_interval(months => (select value from setting where key = 'audit_event'));
  get diagnostics n = row_count; return n;
end $$;

create or replace function private.run_retention(p_batch integer default 1000) returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare rule record; due_sql text; v integer; ids text[]; n integer := 0; keys text[] := '{}'; k text[]; left_n bigint; skipped jsonb := '[]'; res jsonb; i text; out jsonb;
  fn text := 'run_retention by ' || session_user;
begin
  for rule in select * from private.retention_rules()
  loop
    select value into v from setting where key = rule.key;
    if v is null then continue; end if;
    due_sql := rule.due;
    -- R4: a candidate whose rows an open case freezes is told once per rule (rule 1's rows are applications, the others candidates)
    if rule.ord in (1, 5, 6, 8) then
      execute 'with p as (select distinct ' || case when rule.ord = 1 then '(select candidate_user_id from application where id = x.id::bigint)' else 'x.id' end || ' as id from ('
        || due_sql || ' and exists (select 1 from services_case c where c.candidate_user_id = ' || case when rule.ord = 1 then 'a.candidate_user_id' else 'u.id' end
        || $s$ and c.status <> 'closed')) x),
           f as (select u.id, u.email, u.deleted_at, 'deletion_on_hold:' || $2 || ':' || u.id as dk from candidate_user u join p on p.id = u.id
                  where not exists (select 1 from notification n where n.dedupe_key = 'deletion_on_hold:' || $2 || ':' || u.id)),
           ins as (insert into notification(candidate_user_id, category, template_key, params, dedupe_key)
                  select id, 'account', 'deletion_on_hold', jsonb_build_object('rule', $2), dk from f on conflict (dedupe_key) do nothing returning dedupe_key)
         insert into email_outbox(template, candidate_user_id, params, dedupe_key)
           select 'deletion_on_hold', f.id, jsonb_build_object('rule', $2) || case when f.deleted_at is not null then jsonb_build_object('email', f.email) else '{}' end, f.dk
             from f join ins on ins.dedupe_key = f.dk on conflict (dedupe_key) do nothing$s$ using v, rule.key;
    end if;
    -- rows an open case freezes, or an erase function would refuse, are left out of the due rows and listed
    if rule.refuse is not null then
      for i in execute 'select id from (' || due_sql || ' and (' || rule.refuse || ') limit 50) x' using v loop
        skipped := skipped || jsonb_build_object('rule', rule.key, 'target', rule.target, 'id', i, 'reason', 'frozen_or_refused'); end loop;
      due_sql := due_sql || ' and not (' || rule.refuse || ')';
    end if;
    execute 'select coalesce(array_agg(id), ''{}'') from (' || due_sql || ' limit ' || p_batch || ') x' into ids using v;
    if cardinality(ids) = 0 then continue; end if;
    if rule.kind = 'sql' then
      execute rule.act into n, keys using v, ids;
    else
      n := 0;
      foreach i in array ids loop
        if rule.kind = 'erase_candidate' then res := private.erase_candidate(i, rule.on_request); else res := private.erase_portal_user(i, rule.on_request); end if;
        if (res->>'erased')::boolean then n := n + 1; keys := keys || array(select jsonb_array_elements_text(res->'storage_keys'));
        else skipped := skipped || jsonb_build_object('rule', rule.key, 'target', rule.target, 'id', i, 'reason', res->>'reason'); end if;
      end loop;
    end if;
    execute 'select count(*) from (' || due_sql || ') x' into left_n using v;
    out := jsonb_build_object('rule', rule.key, 'target', rule.target, 'done', n, 'left', left_n, 'skipped', skipped, 'storage_keys', to_jsonb(keys));
    insert into audit_event(kind, actor_system, action, after, source) values ('admin_action', fn, 'retention.run', out - 'storage_keys' - 'skipped', 'scheduled_job');
    return out;
  end loop;
  -- approval requests after the audit period, only when nothing points to them (24 months, as in audit_purge); not a setting
  -- C3 FIX 1: the due rows come from one function, so `left` counts only rows the delete can reach
  delete from approval_request a where a.id in (select private.approval_request_due() limit p_batch);
  get diagnostics n = row_count;
  if n > 0 then return jsonb_build_object('rule', 'approval_request', 'done', n, 'left', (select count(*) from private.approval_request_due()), 'skipped', skipped, 'storage_keys', '[]'::jsonb); end if;
  return jsonb_build_object('rule', null, 'done', 0, 'left', 0, 'skipped', skipped, 'storage_keys', '[]'::jsonb);
end $$;

reset role;
