-- Step 15 staff tools C (audit rows Q6, Q7; 19 Nov 2026). Tests: packages/db/test/staff-uploads.test.ts.
--   1. Q7: strike.evidence_storage_key, the one stored evidence file of a case (key evidence/<uuid>.<ext>), set by app_admin (trust_and_safety,
--      packages/db/src/trust-safety.ts) only while it is empty. report.evidence_storage_key (0001) is the report's own, set the same way.
--   2. Retention: rules 21 and 23 (strike), 22 (report) and 32 (a closed job's sponsorship statements, whose admin_on_behalf rows hold the employer's
--      written confirmation, Q6) now return the stored file keys of the rows they delete, so retention-cli.ts removes each file with its row.
--      The rule text is edited in place, as 0038 and 0041 do; each old text must be found the number of times it is expected.
set role portal_owner;

alter table strike add column evidence_storage_key text;
grant update (evidence_storage_key) on strike to app_admin;

do $m$
declare
  def text := pg_get_functiondef('private.retention_rules()'::regprocedure);
  edits constant text[][] := array[
    array[$o$with d as (delete from strike where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$o$,
          $o$with d as (delete from strike where id = any($2::bigint[]) returning evidence_storage_key) select count(*)::int, coalesce(array_agg(evidence_storage_key) filter (where evidence_storage_key is not null), '{}') from d$o$, '2'],
    array[$o$with d as (delete from report where id = any($2::bigint[]) returning 1) select count(*)::int, '{}'::text[] from d$o$,
          $o$with d as (delete from report where id = any($2::bigint[]) returning evidence_storage_key) select count(*)::int, coalesce(array_agg(evidence_storage_key) filter (where evidence_storage_key is not null), '{}') from d$o$, '1'],
    array[$o$with s as (delete from sponsorship_statement where job_id = any($2::bigint[]) returning 1),$o$,
          $o$with s as (delete from sponsorship_statement where job_id = any($2::bigint[]) returning confirmation_file_key),$o$, '1'],
    array[$o$select (select count(*) from d)::int, '{}'::text[]$q$, null),
    (33,$o$,
          $o$select (select count(*) from d)::int, coalesce((select array_agg(confirmation_file_key) filter (where confirmation_file_key is not null) from s), '{}')$q$, null),
    (33,$o$, '1']];
  i int;
begin
  for i in 1 .. array_length(edits, 1) loop
    if (length(def) - length(replace(def, edits[i][1], ''))) <> length(edits[i][1]) * edits[i][3]::int then
      raise exception '0052: retention text % not found % time(s)', i, edits[i][3]; end if;
    def := replace(def, edits[i][1], edits[i][2]);
  end loop;
  execute def;
end $m$;

reset role;
