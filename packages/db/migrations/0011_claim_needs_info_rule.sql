-- Retention rule 13 (claim_needs_info): after 30 days in needs_info, only a CLAIM goes back to unclaimed. A new registration becomes rejected.
-- 0002 sent every company back to unclaimed, so a registration (a number and a name made up by whoever signed up) became a company anyone
-- could claim as if it were a DETE sponsor, and its number stayed blocked for the real company. The rule also drops the company's open
-- account_review item: since "ask for more" now leaves that item open (step 7 slice 3 fixes), it would otherwise stay in the queue for a company
-- no longer waiting. Only that one rule changes; the rest of the function is the text 0002 made, edited in place and checked.
set role portal_owner;

do $m$
declare
  old_sql constant text := $o$with d as (update organisation set status = 'unclaimed' where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$o$;
  new_sql constant text := $o$with d as (update organisation set status = case when signup_path = 'dete_claim' then 'unclaimed' else 'rejected' end where id = any($2::bigint[]) returning id),
             i as (update review_item set status = 'dropped', outcome = 'needs_info_expired', decided_at = now() where queue = 'account_review' and status in ('open','claimed') and organisation_id in (select id from d))
        select count(*)::int, '{}'::text[] from d$o$;
  def text := pg_get_functiondef('private.retention_rules()'::regprocedure);
begin
  if (length(def) - length(replace(def, old_sql, ''))) <> length(old_sql) then raise exception '0011: rule 13 text not found exactly once'; end if;
  execute replace(def, old_sql, new_sql);
end $m$;

reset role;
