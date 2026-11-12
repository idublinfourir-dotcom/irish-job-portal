-- C3 fixtures for the full retention drain. Run as postgres in c3. Replica mode (triggers and FK checks off, CHECKs on) is used for the guarded tables; c3t.orphans() checks the links afterwards.
set session_replication_role = replica;
create or replace function c3t.mkjob(p_id bigint, p_org bigint, p_status text, p_closed timestamptz default null, p_created timestamptz default now(), p_fa bigint default null) returns void language sql as $$
 insert into job(id, organisation_id, source, job_source_id, fetched_advert_id, title, employer_name, sector, permit_type, badge, pass_route, salary_low, status, close_reason, created_at, posted_at, closes_at, closed_at, own_page_url, permit_history, application_route, search_vector)
 overriding system value
 values (p_id, p_org, case when p_fa is null then 'employer' else 'fetched' end, 2, p_fa, 'c3 job '||p_id, 'C3 Employer', 'IT',
   case when p_fa is null then 'general' else 'critical_skills' end, case when p_fa is null then null else 'critical_skills_eligible' end, case when p_fa is null then null else 'stated_pay' end,
   case when p_fa is null then 40000 end, p_status, case when p_status='closed' then 'closed' end, p_created, p_created, 'infinity', p_closed, 'https://jobs.example.test/c3/'||p_id, 'not_linked', 'own_page', case when p_status='live' then to_tsvector('english','c3 job') end);
$$;
-- staff, texts, sources
insert into staff_user(id,name,email,email_verified) values ('c3-st1','Staff One','c3.st1@example.test',true),('c3-st2','Staff Two','c3.st2@example.test',true),('c3-st3','Staff Three','c3.st3@example.test',true);
insert into staff_role(staff_user_id,role,seeded_by_owner) values ('c3-st1','trust_and_safety',true),('c3-st2','trust_and_safety',true),('c3-st3','administrator',true);
insert into consent_text(id,purpose,version,body) overriding system value select g, p, 'v1', 'c3 consent text' from unnest(array['signup_terms','privacy_notice','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor']) with ordinality as t(p,g);
insert into job_source(id,kind,board) overriding system value values (1,'board','c3-board'),(2,'portal','portal');
-- organisations (ids 1..)
insert into organisation(id,slug,display_name,kind,status,signup_path,claimed_at,verified_at,status_changed_at,permit_history) overriding system value
 select g, 'c3-org-'||g, 'C3 Org '||g, 'employer', 'verified', 'first_time', now(), now(), now(), 'not_linked' from generate_series(1,12) g;
-- org 20: needs_info 31 days, org 21: needs_info 10 days
insert into organisation(id,slug,display_name,kind,status,signup_path,claimed_at,status_changed_at,permit_history) overriding system value
 values (20,'c3-needs-old','C3 Needs Old','employer','needs_info','dete_claim',now()-interval '40 days',now()-interval '31 days','not_linked'),
        (21,'c3-needs-new','C3 Needs New','employer','needs_info','first_time',now()-interval '40 days',now()-interval '10 days','not_linked');
-- people --------------------------------------------------------------
-- candidate_user(id,name,email,email_verified,created_at,last_active_at,deleted_at,inactive_warned_at)
create or replace function c3t.mkc(p_id text, p_verified boolean default true, p_created timestamptz default now(), p_active timestamptz default now(), p_deleted timestamptz default null, p_warned timestamptz default null) returns void language sql as $$
 insert into candidate_user(id,name,email,email_verified,created_at,updated_at,last_active_at,deleted_at,inactive_warned_at) values (p_id,'C3 Person '||p_id,p_id||'@example.test',p_verified,p_created,p_created,p_active,p_deleted,p_warned);
 insert into candidate_account(id,account_id,provider_id,user_id,password,updated_at) values ('acct-'||p_id,p_id,'credential',p_id,'x',now());
 insert into candidate_session(id,expires_at,token,updated_at,user_id) values ('sess-'||p_id,now()+interval '7 days','tok-'||p_id,now(),p_id);
 insert into candidate_verification(id,identifier,value,expires_at) values ('ver-'||p_id,'reset:'||p_id,p_id,now()+interval '1 hour');
$$;
create or replace function c3t.mkprof(p_id text) returns void language sql as $$
 insert into candidate_profile(candidate_user_id,full_name,phone) values (p_id,'Name '||p_id,'+3530000');
 insert into candidate_cv(candidate_user_id,storage_key,file_name,content_type,size_bytes) values (p_id,'cv/'||p_id||'/current.pdf','cv.pdf','pdf',1000);
$$;
-- application groups: candidates a1 (job closed 13m), a2 (13m, open case), a3 (11m), a5 (37m, still has candidate id), plus a record with no candidate
select c3t.mkc(x) from unnest(array['c3-a1','c3-a2','c3-a3','c3-a5','c3-a6']) x;
-- inactive group
select c3t.mkc('c3-i1', p_active => now()-interval '13 months'); select c3t.mkprof('c3-i1');
select c3t.mkc('c3-i2', p_active => now()-interval '11 months'); select c3t.mkprof('c3-i2');
select c3t.mkc('c3-i3', p_active => now()-interval '14 months', p_warned => now()-interval '31 days'); select c3t.mkprof('c3-i3');
select c3t.mkc('c3-i4', p_active => now()-interval '14 months', p_warned => now()-interval '10 days'); select c3t.mkprof('c3-i4');
select c3t.mkc('c3-i5', p_active => now()-interval '25 months'); select c3t.mkprof('c3-i5');
select c3t.mkc('c3-i6', p_active => now()-interval '25 months'); select c3t.mkprof('c3-i6');   -- open services case
select c3t.mkc('c3-i7', p_active => now()-interval '25 months'); select c3t.mkprof('c3-i7');   -- open report on profile
select c3t.mkc('c3-i8', p_active => now()-interval '14 months', p_warned => now()-interval '31 days'); -- warned, profile and cv already gone
-- unverified and deleted
select c3t.mkc('c3-u1', false, now()-interval '8 days'); select c3t.mkc('c3-u2', false, now()-interval '5 days');
select c3t.mkc('c3-d1', p_deleted => now()-interval '31 days'); select c3t.mkprof('c3-d1');
select c3t.mkc('c3-d2', p_deleted => now()-interval '31 days');   -- open case
select c3t.mkc('c3-d3', p_deleted => now()-interval '10 days');
select c3t.mkc('c3-d4', p_deleted => now()-interval '31 days');   -- open report on profile
-- portal users
create or replace function c3t.mkp(p_id text, p_verified boolean default true, p_created timestamptz default now(), p_deleted timestamptz default null) returns void language sql as $$
 insert into portal_user(id,name,email,email_verified,created_at,updated_at,deleted_at,last_active_at) values (p_id,'C3 Portal '||p_id,p_id||'@example.test',p_verified,p_created,p_created,p_deleted,now());
 insert into portal_account(id,account_id,provider_id,user_id,password,updated_at) values ('acct-'||p_id,p_id,'credential',p_id,'x',now());
 insert into portal_session(id,expires_at,token,updated_at,user_id) values ('sess-'||p_id,now()+interval '7 days','tok-'||p_id,now(),p_id);
 insert into portal_verification(id,identifier,value,expires_at) values ('ver-'||p_id,'reset:'||p_id,p_id,now()+interval '1 hour');
$$;
select c3t.mkp('c3-pu1', false, now()-interval '8 days'); select c3t.mkp('c3-pu2', false, now()-interval '5 days');
select c3t.mkp('c3-pd1', p_deleted => now()-interval '31 days');
select c3t.mkp('c3-pd2', p_deleted => now()-interval '31 days');         -- owner with other members
select c3t.mkp('c3-pd2m');                                                -- the other member
select c3t.mkp('c3-pr1'); select c3t.mkp('c3-pr2'); select c3t.mkp('c3-pr3', p_created => now()-interval '13 months'); select c3t.mkp('c3-pr4', p_created => now()-interval '11 months');
-- memberships: org 1 owner pd2 + member pd2m ; org 2 pr1 removed 13m ; org 3 pr2 removed 11m ; org 20 (needs_info old) a member
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values
 (1,1,'c3-pd2','account_owner','active',true,now()),(2,1,'c3-pd2m','recruiter','active',false,now());
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at,removed_at) overriding system value values
 (3,2,'c3-pr1','recruiter','removed',false,now()-interval '20 months',now()-interval '13 months'),
 (4,3,'c3-pr2','recruiter','removed',false,now()-interval '20 months',now()-interval '11 months');
select c3t.mkp('c3-pn1'); insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values (5,20,'c3-pn1','account_owner','active',true,now());
-- a member for org 4..12 signers
select c3t.mkp('c3-pm'||g) from generate_series(4,12) g;
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value
 select 10+g, g, 'c3-pm'||g, 'recruiter', 'active', false, now() from generate_series(4,12) g;
-- a live-ish draft job on org 20, so the return to unclaimed has something to close
select c3t.mkjob(9001, 20, 'draft');
-- jobs: closed ones for applications etc. job 1001 closed 13m, 1002 13m (open case), 1003 11m, 1005 37m, 1006 37m (record only), 1007 35m
select c3t.mkjob(1001, 4, 'closed', now()-interval '13 months'); select c3t.mkjob(1002, 4, 'closed', now()-interval '13 months'); select c3t.mkjob(1003, 4, 'closed', now()-interval '11 months');
select c3t.mkjob(1005, 4, 'closed', now()-interval '37 months'); select c3t.mkjob(1006, 4, 'closed', now()-interval '37 months'); select c3t.mkjob(1007, 4, 'closed', now()-interval '35 months');
-- consent records: for applications (job + org + details), ids 101..
insert into consent_record(id,candidate_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values
 (101,'c3-a1',4,1001,4,'{"shared":["profile"]}'),(102,'c3-a2',4,1002,4,'{"shared":["profile"]}'),(103,'c3-a3',4,1003,4,'{"shared":["profile"]}'),(104,'c3-a5',4,1005,4,'{"shared":["profile"]}'),
 (105,'c3-a6',4,1006,4,'{"shared":["profile"]}');
-- applications
insert into application(id,job_id,organisation_id,candidate_user_id,status,cover_note,answers,profile_summary,cv_storage_key,cv_file_name,consent_record_id,created_at) overriding system value values
 (201,1001,4,'c3-a1','applied','note','{"q":1}','{"p":1}','applications/201/cv.pdf','cv.pdf',101,now()-interval '14 months'),
 (202,1002,4,'c3-a2','applied','note','{"q":1}','{"p":1}','applications/202/cv.pdf','cv.pdf',102,now()-interval '14 months'),
 (203,1003,4,'c3-a3','applied','note','{"q":1}','{"p":1}','applications/203/cv.pdf','cv.pdf',103,now()-interval '12 months'),
 (205,1005,4,'c3-a5','applied','note','{"q":1}','{"p":1}','applications/205/cv.pdf','cv.pdf',104,now()-interval '38 months'),
 (206,1006,4,'c3-a6','applied','note','{"q":1}','{"p":1}','applications/206/cv.pdf','cv.pdf',105,now()-interval '38 months');
-- record-only applications (no candidate): 207 on job 1006 (37m, due), 208 on job 1007 (35m, not due)
insert into application(id,job_id,organisation_id,status,created_at) overriding system value values (207,1006,4,'applied',now()-interval '38 months'),(208,1007,4,'applied',now()-interval '36 months');
insert into tracker_entry(candidate_user_id,job_id,route,origin,stage,application_id) values ('c3-a1',1001,'on_site','on_site','applied',201),('c3-a3',1003,'on_site','on_site','applied',203);
insert into message(application_id,sender_candidate_user_id,body) values (201,'c3-a1','hello'),(203,'c3-a3','hello');
-- open services case for a2 and i6 and d2 (consent record 106..108 services_request)
insert into consent_record(id,candidate_user_id,consent_text_id) overriding system value values (106,'c3-a2',6),(107,'c3-i6',6),(108,'c3-d2',6);
insert into services_case(id,candidate_user_id,permit_type,payer,status,consent_record_id,offer_details,job_id) overriding system value values
 (301,'c3-a2','critical_skills','employer','received',106,'{"salary":50000}',1002),(302,'c3-i6','critical_skills','employer','received',107,'{"salary":50000}',null),(303,'c3-d2','critical_skills','employer','received',108,'{"salary":50000}',null);
-- open reports against profile of i7 and d4
insert into report(id,target_kind,target_candidate_user_id,reason,status) overriding system value values (401,'profile','c3-i7','other','open'),(402,'profile','c3-d4','other','open');
-- apply clicks and contact requests
select c3t.mkjob(1010, 5, 'live');
select c3t.mkc('c3-k1');
insert into apply_click(candidate_user_id,job_id,clicked_at,status) values ('c3-k1',1010,now()-interval '15 days','pending'),('c3-k1',1003,now()-interval '5 days','pending');
insert into consent_record(id,candidate_user_id,consent_text_id) overriding system value values (109,'c3-k1',5);
insert into contact_request(id,organisation_id,membership_id,candidate_user_id,status,sent_at,answered_at,consent_record_id) overriding system value values
 (501,4,14,'c3-k1','declined',now()-interval '14 months',now()-interval '13 months',null),
 (502,5,15,'c3-k1','declined',now()-interval '12 months',now()-interval '11 months',null),
 (503,6,16,'c3-k1','sent',now()-interval '15 days',null,null),
 (504,7,17,'c3-k1','sent',now()-interval '5 days',null,null);
