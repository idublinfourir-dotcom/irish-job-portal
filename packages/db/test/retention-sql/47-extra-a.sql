-- C3 extra tests A: sign-in clears warning, closed_at on a portal close, real ban lift. Run as postgres in c3 after 46-run.sh (state after the drain).
\set ON_ERROR_STOP 0
-- T1: a sign-in after the warning clears it; the profile and CV then survive the warning period
set session_replication_role = replica;
select c3t.mkc('c3-i9', p_active => now()-interval '14 months', p_warned => now()-interval '31 days'); select c3t.mkprof('c3-i9');
reset session_replication_role;
begin; set local role app_candidate; update candidate_user set last_active_at = now() where id = 'c3-i9'; commit;
select c3t.chk('signin','a sign-in (app_candidate sets last_active_at) clears inactive_warned_at', $$ select inactive_warned_at is null and last_active_at > now()-interval '1 minute' from candidate_user where id='c3-i9' $$);
set role app_admin; select c3t.drain() \gset
reset role;
select c3t.chk('signin','after the sign-in the 31-day-old warning no longer deletes the profile and CV', $$ select exists(select 1 from candidate_profile where candidate_user_id='c3-i9') and exists(select 1 from candidate_cv where candidate_user_id='c3-i9') $$);
-- T2: a portal close of a live job must carry closed_at (retention counts from it)
set session_replication_role = replica;
select c3t.mkjob(1401, 4, 'live'); update job set closes_at = now() + interval '10 days', posted_by_membership_id = 14 where id = 1401; -- 14: org 4's active recruiter (0019's poster check)
reset session_replication_role;
begin; set local role app_portal; update job set status = 'closed' where id = 1401; commit;
select c3t.chk('closed_at','a job closed by app_portal (status closed, nothing else sent) has closed_at set', $$ select status='closed' and closed_at is not null from job where id=1401 $$);
-- T3: real ban lift (two staff), then evidence kept 12 months after the lift
set session_replication_role = replica;
insert into approval_request(id,kind,target_table,target_id,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,applied_at,created_at) overriding system value values (990,'strike_3','strike','20','c3-st1','c3-st2','confirmed',now(),now(),now());
insert into strike(id,organisation_id,case_kind,reason_code,level,stage,outcome,decided_by_staff_user_id,decided_at,approval_request_id,notice_summary) overriding system value values (20,3,'false_claim','false_sponsorship',3,'applied','strike','c3-st1',now()-interval '30 months',990,'x'),(21,3,'false_claim','false_sponsorship',1,'applied','strike','c3-st1',now()-interval '40 months',null,'x');
insert into ban(id,cro_number,reason_code,strike_id,approval_request_id) overriding system value values (20,'CRO20','strike_3',20,990);
select c3t.fixseq();
reset session_replication_role;
begin; set local role app_admin; set local app.staff_user_id = 'c3-st1';
 insert into approval_request(kind,target_table,target_id) values ('ban_lift','ban','20');
commit;
begin; set local role app_admin; set local app.staff_user_id = 'c3-st2';
 update approval_request set status = 'confirmed' where kind='ban_lift' and target_id='20';
commit;
begin; set local role app_admin; set local app.staff_user_id = 'c3-st1'; delete from ban where id = 20; commit;
select c3t.chk('banlift','the lift stamped ban_lifted_at on the case and removed the ban row', $$ select (select ban_lifted_at is not null from strike where id=20) and not exists(select 1 from ban where id=20) $$);
set role app_admin; select c3t.drain() \gset
reset role;
select c3t.chk('banlift','right after the lift the evidence (case 20 and its earlier strike 21) is kept', $$ select (select count(*) from strike where id in (20,21))=2 $$);
set session_replication_role = replica; update strike set ban_lifted_at = now() - interval '11 months' where id = 20; reset session_replication_role;
set role app_admin; select c3t.drain() \gset
reset role;
select c3t.chk('banlift','11 months after the lift the evidence is still kept', $$ select (select count(*) from strike where id in (20,21))=2 $$);
set session_replication_role = replica; update strike set ban_lifted_at = now() - interval '13 months' where id = 20; reset session_replication_role;
set role app_admin; select c3t.drain() \gset
reset role;
select c3t.chk('banlift','13 months after the lift the case and its earlier strike are deleted', $$ select (select count(*) from strike where id in (20,21))=0 $$);
select grp, count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail from c3t.result where grp in ('signin','closed_at','banlift') group by grp order by 1;
select 'FAIL: ' || name || ' | ' || left(detail,200) from c3t.result where not ok and grp in ('signin','closed_at','banlift') order by n;
