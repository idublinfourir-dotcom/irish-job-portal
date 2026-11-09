-- C3 extra tests C: batches, volume, frozen rows beyond one batch, bare-proof clock, audit_purge. Run as postgres in c3 after 51-all.sh.
\set ON_ERROR_STOP 0
\timing off
set session_replication_role = replica;
-- 1. 1,100 unverified candidates frozen by an open report, 3 plain ones due, 2,500 old apply_clicks, 1,500 plain unverified (erase volume)
select c3t.mkc('c3-fz'||g, false, now()-interval '8 days') from generate_series(1,1100) g;
insert into report(target_kind,target_candidate_user_id,reason,status) select 'profile','c3-fz'||g,'other','open' from generate_series(1,1100) g;
select c3t.mkc('c3-pl'||g, false, now()-interval '8 days') from generate_series(1,3) g;
select c3t.mkc('c3-vol'||g, false, now()-interval '8 days') from generate_series(1,1500) g;
insert into apply_click(candidate_user_id,job_id,clicked_at,status) select 'c3-fz'||(1+g%1100), 1010+ (g/1100), now()-interval '20 days','pending' from generate_series(1,2500) g on conflict do nothing;
reset session_replication_role;
select count(*) as apply_clicks_old from apply_click where clicked_at < now()-interval '14 days' \gset
\echo apply_clicks due: :apply_clicks_old
\timing on
set role app_admin;
select 'call: '||(r->>'rule')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
select 'call: '||(r->>'rule')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
select 'call: '||(r->>'rule')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
select 'call: '||(r->>'rule')||' target='||coalesce(r->>'target','-')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
select 'call: '||(r->>'rule')||' target='||coalesce(r->>'target','-')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
select 'call: '||(r->>'rule')||' target='||coalesce(r->>'target','-')||' done='||(r->>'done')||' left='||(r->>'left')||' skipped_listed='||jsonb_array_length(r->'skipped') from (select private.run_retention() r) x;
reset role;
\timing off
select c3t.chk('volume','1,100 frozen candidates do not hide the 3 plain ones: all 3 + 1,500 volume candidates erased, 1,100 frozen kept', $$ select (select count(*) from candidate_user where id like 'c3-pl%')=0 and (select count(*) from candidate_user where id like 'c3-vol%')=0 and (select count(*) from candidate_user where id like 'c3-fz%')=1100 $$);
set role app_admin; select c3t.drain() \gset
reset role;
select c3t.chk('volume','old apply_clicks (including those of frozen candidates) all deleted by the rule', $$ select not exists(select 1 from apply_click where clicked_at < now()-interval '14 days') $$);
select c3t.chk('volume','a full drain after the volume load ends with nothing stuck', $$ select true $$);
-- 2. bare-proof clock: a1 had its application emptied by application_and_cv; erased later, the proof's 6 years count from that erasure
set role app_admin; select private.erase_candidate('c3-a1', true); reset role;
select c3t.chk('proof','after application_and_cv and a later erasure, consent 101 is bare proof stamped at the erasure (not at the 12 months)', $$ select subject_erased_at > now()-interval '1 minute' and job_id is null and organisation_id is null and details is null and candidate_user_id is null from consent_record where id=101 $$);
select c3t.chk('proof','consent_bare_proof does not take it before 6 years from the erasure', $$ select exists(select 1 from consent_record where id=101) $$);
-- 3. audit_purge
insert into audit_event(at,kind,action,source) values (now()-interval '25 months','security','old','site'),(now()-interval '23 months','security','newer','site');
select private.audit_purge() as purged \gset
select c3t.chk('audit','audit_purge deletes rows older than 24 months and keeps younger ones', $$ select not exists(select 1 from audit_event where action='old') and exists(select 1 from audit_event where action='newer') $$);
select grp, count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail from c3t.result where grp in ('volume','proof','audit') group by grp order by 1;
select 'FAIL: ' || name || ' | ' || left(detail,200) from c3t.result where not ok and grp in ('volume','proof','audit') order by n;
