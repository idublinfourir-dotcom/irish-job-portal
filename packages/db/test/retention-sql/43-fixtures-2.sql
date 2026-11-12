-- C3 fixtures part 2. Run after 42-fixtures-all.sql, as postgres, replica mode.
set session_replication_role = replica;
-- signer names ------------------------------------------------------
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values (30,8,'c3-pm8','recruiter','active',true,now()) on conflict do nothing;
update membership set is_signer = true where id = 18;
select c3t.mkjob(1101, 8, 'closed', now()-interval '13 months'); select c3t.mkjob(1102, 8, 'closed', now()-interval '11 months'); select c3t.mkjob(1103, 8, 'closed', now()-interval '13 months');
insert into sponsorship_statement(id,job_id,organisation_id,kind,consent_text_id,signer_membership_id,signer_name,signer_title,signed_at) overriding system value values
 (1,1101,8,'own_company',8,18,'Real Signer','Head of People',now()-interval '20 months'),
 (2,1102,8,'own_company',8,18,'Real Signer','Head of People',now()-interval '20 months'),
 (3,1103,8,'own_company',8,18,'Real Signer','Head of People',now()-interval '20 months');
-- pay floors: ended 13 months (due), ended 11 months, ended 13 months with a strike pointing at it
insert into approval_request(id,kind,target_table,target_id,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,applied_at,created_at) overriding system value
 select 900+g,'pay_floor','pay_floor',g::text,'c3-st1','c3-st2','confirmed',now(),now(),now() from generate_series(1,3) g;
insert into pay_floor(id,organisation_id,role_family,floor_eur,consent_text_id,signer_membership_id,signer_name,signer_title,signed_at,valid_until,status,ended_at,approval_request_id) overriding system value values
 (1,8,'2134',60000,9,18,'Real Signer','Head',now()-interval '30 months',now()-interval '14 months','expired',now()-interval '13 months',901),
 (2,8,'2230',60000,9,18,'Real Signer','Head',now()-interval '30 months',now()-interval '12 months','expired',now()-interval '11 months',902),
 (3,8,'5434',60000,9,18,'Real Signer','Head',now()-interval '30 months',now()-interval '14 months','expired',now()-interval '13 months',903);
-- services cases ------------------------------------------------------
select c3t.mkc('c3-sc1');
insert into consent_record(id,candidate_user_id,consent_text_id) overriding system value select 110+g,'c3-sc1',6 from generate_series(1,8) g;
insert into services_case(id,candidate_user_id,permit_type,payer,status,consent_record_id,offer_details,closed_at,close_reason) overriding system value values
 (311,'c3-sc1','critical_skills','employer','closed',111,'{"salary":1}',now()-interval '31 days','decided'),   -- copy due
 (312,'c3-sc1','critical_skills','employer','closed',112,'{"salary":2}',now()-interval '73 months','decided'), -- record due, no quotes
 (313,'c3-sc1','critical_skills','employer','closed',113,'{"salary":3}',now()-interval '73 months','decided'), -- record due after its quote goes
 (314,'c3-sc1','critical_skills','employer','closed',114,'{"salary":4}',now()-interval '71 months','decided'), -- not due: offer details must stay
 (315,'c3-sc1','critical_skills','employer','closed',115,'{"salary":5}',now()-interval '10 days','decided'),   -- copy not due
 (316,'c3-sc1','critical_skills','employer','received',116,'{"salary":6}',null,null);                          -- open
update services_case set requester_erased_at = now() where id = 313;  -- (erased requester: candidate id emptied, still kept)
update services_case set candidate_user_id = null where id = 313;
insert into case_note(services_case_id,author_staff_user_id,body) values (312,'c3-st1','n'),(312,'c3-st1','n2'),(314,'c3-st1','n');
insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) values
 (311,'cases/311/a.pdf','a.pdf','application/pdf',1,'c3-sc1'),(312,'cases/312/a.pdf','a.pdf','application/pdf',1,'c3-sc1'),(315,'cases/315/a.pdf','a.pdf','application/pdf',1,'c3-sc1');
update case_document set storage_key = null, file_name = null, copy_deleted_at = now() where services_case_id = 312;  -- copy already gone (30 days passed long ago)
insert into case_quote(id,services_case_id,amount_eur,status,invoice_number) overriding system value values (1,313,900,'paid','INV-313'),(2,314,900,'paid','INV-314');
-- strikes, reports, bans ----------------------------------------------------
insert into approval_request(id,kind,target_table,target_id,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,applied_at,created_at) overriding system value
 select 910+g, case when g%3=0 then 'ban' when g%3=1 then 'strike_2' else 'strike_3' end, 'strike', g::text, 'c3-st1','c3-st2','confirmed',now(),now(),now() from generate_series(1,20) g;
-- reports 1..5
insert into report(id,target_kind,target_job_id,reason,status,decided_at,decided_by_staff_user_id) overriding system value values
 (1,'job',1010,'other','upheld',now()-interval '13 months','c3-st1'),     -- pointed to by strike 1 (goes with it, then report on a later call)
 (2,'job',1010,'other','cleared',now()-interval '13 months','c3-st1'),    -- no strike: due at once
 (3,'job',1010,'other','cleared',now()-interval '13 months','c3-st1'),    -- hides a job: stays
 (4,'job',1010,'other','cleared',now()-interval '11 months','c3-st1'),    -- not due
 (5,'job',1010,'other','upheld',now()-interval '40 months','c3-st1');     -- pointed to by e2 ban case: stays while ban stands
select c3t.mkjob(1020, 9, 'draft'); update job set status='hidden', hidden_reason='report', hidden_report_id=3, close_reason=null where id=1020;
-- org 9 (e1): strike 1 decided 13m (due); strike 1b decided 11m (not due)
-- org 10 (e2): ban case (level 3) decided 14m, ban row stands, earlier level 1 (decided 30m) and level 2 (decided 20m): all kept
-- org 11 (e3): ban case decided 30m, ban lifted 13m ago (ban row gone): evidence due at 12 months after lift. earlier level 1 also due.
-- org 12 (e4): ban case decided 30m, lifted 5m ago: kept. earlier level 1 kept too.
-- org 1 (e5): appeal decided 3m ago on strike decided 14m ago: not due
insert into strike(id,organisation_id,case_kind,report_id,reason_code,level,stage,outcome,decided_by_staff_user_id,decided_at,approval_request_id,notice_summary,ban_lifted_at) overriding system value values
 (1, 9,'false_claim',1,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '13 months',null,'x',null),
 (2, 9,'false_claim',null,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '11 months',null,'x',null),
 (3,10,'false_claim',5,'false_sponsorship',3,'applied','strike','c3-st1',now()-interval '14 months',911,'x',null),
 (4,10,'false_claim',null,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '30 months',null,'x',null),
 (5,10,'false_claim',null,'false_sponsorship',2,'applied','strike','c3-st1',now()-interval '20 months',912,'x',null),
 (6,11,'false_claim',null,'false_sponsorship',3,'applied','strike','c3-st1',now()-interval '30 months',913,'x',now()-interval '13 months'),
 (7,11,'false_claim',null,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '40 months',null,'x',null),
 (8,12,'false_claim',null,'false_sponsorship',3,'applied','strike','c3-st1',now()-interval '30 months',914,'x',now()-interval '5 months'),
 (9,12,'false_claim',null,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '40 months',null,'x',null);
insert into strike(id,organisation_id,case_kind,reason_code,level,stage,outcome,decided_by_staff_user_id,decided_at,appealed_at,appeal_decided_by_staff_user_id,appeal_decided_at,notice_summary) overriding system value values
 (10,1,'false_claim','false_sponsorship',1,'upheld','strike','c3-st1',now()-interval '14 months',now()-interval '13 months','c3-st2',now()-interval '3 months','x');
insert into ban(id,cro_number,reason_code,strike_id,approval_request_id) overriding system value values (1,'CRO10','strike_3',3,911);
-- consent bare proof --------------------------------------------------------
insert into consent_record(id,consent_text_id,subject_erased_at,given_at) overriding system value values
 (201,4,now()-interval '73 months',now()-interval '90 months'),(202,4,now()-interval '60 months',now()-interval '90 months'),(203,4,now()-interval '73 months',now()-interval '90 months');
select c3t.mkjob(1030, 4, 'closed', now()-interval '1 month');
insert into application(id,job_id,organisation_id,status,consent_record_id) overriding system value values (231,1030,4,'applied',203);  -- record points to consent 203: stays
-- contact messages ----------------------------------------------------------
insert into contact_message(id,surface,from_name,from_email,topic,body,status,closed_at,created_at) overriding system value values
 (1,'candidate_site','Visitor','v1@example.test','general','b','closed',now()-interval '25 months',now()-interval '26 months'),
 (2,'candidate_site','Visitor','v2@example.test','general','b','closed',now()-interval '23 months',now()-interval '24 months'),
 (3,'candidate_site','Visitor','v3@example.test','general','b','answered',null,now()-interval '25 months'),
 (4,'candidate_site','Visitor','v4@example.test','general','b','new',null,now()-interval '30 months'),
 (5,'candidate_site','Visitor','v5@example.test','general','b','closed',now()-interval '25 months',now()-interval '26 months'),
 (6,'candidate_site','Visitor','v6@example.test','general','b','spam',null,now()-interval '25 months');
insert into review_item(id,queue,contact_message_id,status,created_at) overriding system value values (1000,'data_request',5,'open',now()-interval '26 months');
insert into review_item(id,queue,job_id,status,decided_at,created_at,outcome) overriding system value values
 (1001,'scam_flag',1010,'done',now()-interval '25 months',now()-interval '26 months','x'),
 (1002,'scam_flag',1010,'done',now()-interval '23 months',now()-interval '24 months','x'),
 (1003,'scam_flag',1010,'dropped',null,now()-interval '25 months',null),
 (1004,'scam_flag',1010,'open',null,now()-interval '30 months',null);
-- notifications ----------------------------------------------------------
insert into notification(candidate_user_id,category,template_key,dedupe_key,read_at,created_at) values
 ('c3-k1','job_closed','t','n1',now()-interval '13 months',now()-interval '14 months'),('c3-k1','job_closed','t','n2',now()-interval '11 months',now()-interval '14 months'),
 ('c3-k1','job_closed','t','n3',null,now()-interval '13 months'),('c3-k1','job_closed','t','n4',null,now()-interval '11 months');
-- email outbox: person rows for erased and kept people; ages around 30 days and 24 months
insert into email_outbox(id,template,candidate_user_id,params,dedupe_key,status,send_after,sent_at) overriding system value values
 (1,'alert','c3-k1','{"a":1}','e1','sent',now()-interval '32 days',now()-interval '31 days'),     -- body due
 (2,'alert','c3-k1','{"a":1}','e2','sent',now()-interval '11 days',now()-interval '10 days'),     -- not due
 (3,'alert','c3-k1','{"a":1}','e3','sent',now()-interval '26 months',now()-interval '25 months'),-- record due (and body)
 (4,'alert','c3-k1','{"a":1}','e4','failed',now()-interval '31 days',null),                       -- body due via send_after
 (5,'alert','c3-k1','{"a":1}','e5','pending',now()-interval '40 days',null),                      -- pending: untouched
 (6,'alert','c3-k1','{"a":1}','e6','sending',now()-interval '40 days',null),                      -- stuck sending: body due
 (7,'alert','c3-k1','{"a":1}','e7','failed',now()-interval '25 months',null),                     -- record due
 (8,'alert','c3-k1','{"a":1}','e8','pending',now()-interval '25 months',null),                    -- pending: untouched
 (9,'alert','c3-k1','{"a":1}','e9','dropped',now()-interval '25 months',null),                    -- record due
 (10,'alert','c3-k1','{"a":1}','e10','sent',now()-interval '24 months'+interval '1 day',now()-interval '24 months'+interval '1 day'); -- record not yet due
-- rejected adverts and closed jobs ------------------------------------------------
insert into fetched_advert(id,job_source_id,external_id,result,stage,last_seen_at) overriding system value values
 (1,1,'c3-fa1','rejected','5',now()-interval '25 months'),(2,1,'c3-fa2','rejected','5',now()-interval '23 months'),(3,1,'c3-fa3','rejected','5',now()-interval '25 months'),
 (4,1,'c3-fa4','passed','PASS',now()-interval '25 months'),(5,1,'c3-fa5','passed','PASS',now()-interval '38 months'),(6,1,'c3-fa6','passed','PASS',now()-interval '38 months');
select c3t.mkjob(1201, 6, 'closed', now()-interval '37 months', p_fa => 3);   -- references advert 3: advert stays
select c3t.mkjob(1202, 6, 'closed', now()-interval '37 months', p_fa => 5);   -- unreferenced: deleted with advert 5
select c3t.mkjob(1203, 6, 'closed', now()-interval '35 months');              -- not due
select c3t.mkjob(1204, 6, 'closed', now()-interval '37 months');              -- saved by someone: stays
select c3t.mkjob(1205, 6, 'closed', now()-interval '37 months');              -- strike points at it: stays
select c3t.mkjob(1206, 6, 'closed', now()-interval '37 months', p_fa => 6);   -- has a statement: statement goes with it
insert into saved_job(candidate_user_id,job_id) values ('c3-k1',1204);
insert into strike(id,organisation_id,case_kind,job_id,reason_code,level,stage,outcome,decided_by_staff_user_id,decided_at,notice_summary) overriding system value values (11,6,'false_claim',1205,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '2 months','x');
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values (40,6,'c3-pd1','recruiter','active',true,now());
insert into sponsorship_statement(id,job_id,organisation_id,kind,consent_text_id,signer_membership_id,signer_name,signed_at) overriding system value values (10,1206,6,'own_company',8,40,'Real Signer',now()-interval '50 months');
-- fetch runs, login rows ------------------------------------------------------
insert into fetch_run(job_source_id,started_at,finished_at,seen,new,closed) values (1,now()-interval '13 months',now(),1,1,1),(1,now()-interval '11 months',now(),1,1,1);
insert into candidate_session(id,expires_at,token,updated_at,user_id) values ('xs-old',now()-interval '2 days','xt-old',now(),'c3-k1'),('xs-new',now()-interval '1 hour','xt-new',now(),'c3-k1');
insert into portal_session(id,expires_at,token,updated_at,user_id) values ('xs-old',now()-interval '2 days','xt-old',now(),'c3-pm4'),('xs-new',now()-interval '1 hour','xt-new',now(),'c3-pm4');
insert into staff_session(id,expires_at,token,updated_at,user_id) values ('xs-old',now()-interval '2 days','xt-old',now(),'c3-st1'),('xs-new',now()-interval '1 hour','xt-new',now(),'c3-st1');
insert into candidate_verification(id,identifier,value,expires_at) values ('xv-old','a','a',now()-interval '2 days'),('xv-new','b','b',now()-interval '1 hour');
insert into portal_verification(id,identifier,value,expires_at) values ('xv-old','a','a',now()-interval '2 days'),('xv-new','b','b',now()-interval '1 hour');
insert into staff_verification(id,identifier,value,expires_at) values ('xv-old','a','a',now()-interval '2 days'),('xv-new','b','b',now()-interval '1 hour');
insert into candidate_rate_limit(id,key,count,last_request) values ('xr-old','k1',1,(extract(epoch from now()-interval '2 days')*1000)::bigint),('xr-new','k2',1,(extract(epoch from now())*1000)::bigint);
insert into portal_rate_limit(id,key,count,last_request) values ('xr-old','k1',1,(extract(epoch from now()-interval '2 days')*1000)::bigint),('xr-new','k2',1,(extract(epoch from now())*1000)::bigint);
insert into staff_rate_limit(id,key,count,last_request) values ('xr-old','k1',1,(extract(epoch from now()-interval '2 days')*1000)::bigint),('xr-new','k2',1,(extract(epoch from now())*1000)::bigint);
-- approval requests older than 24 months: 950 unreferenced (goes), 951 pointed at by pay_floor? use a ban (stays), 952 pending (stays), 953 new
insert into approval_request(id,kind,target_table,target_id,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,created_at) overriding system value values
 (950,'threshold','setting','a','c3-st1','c3-st2','confirmed',now(),now()-interval '25 months'),
 (951,'ban','ban','a','c3-st1','c3-st2','confirmed',now(),now()-interval '25 months'),
 (952,'threshold','setting','b','c3-st1',null,'pending',null,now()-interval '25 months'),
 (953,'threshold','setting','c','c3-st1','c3-st2','confirmed',now(),now()-interval '2 months');
insert into ban(id,email_domain,reason_code,strike_id,approval_request_id) overriding system value values (2,'bad.test','strike_3',3,951);

-- additions: drafts, strikes that protect a statement and a pay floor
select c3t.mkjob(1301, 7, 'draft', p_created => now()-interval '13 months'); select c3t.mkjob(1302, 7, 'draft', p_created => now()-interval '11 months');
insert into job_text(job_id,advert_text) values (1301,'draft text'),(1302,'draft text');
insert into strike(id,organisation_id,case_kind,job_id,pay_floor_id,reason_code,level,stage,outcome,decided_by_staff_user_id,decided_at,notice_summary) overriding system value values
 (12,8,'false_pay_floor',null,3,'false_pay_floor',1,'applied','strike','c3-st1',now()-interval '2 months','x'),
 (13,8,'false_claim',1103,null,'false_sponsorship',1,'applied','strike','c3-st1',now()-interval '2 months','x');
-- people who get erased by a rule: i5 (inactive_account, not on request), d1 (deleted_account_grace, on request), pr1 (portal_removed_member, not on request)
insert into consent_record(id,candidate_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values (301,'c3-i5',4,1010,5,'{"x":1}'),(302,'c3-d1',4,1010,5,'{"x":1}');
insert into consent_record(id,portal_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values (303,'c3-pr1',8,1010,5,'{"x":1}');
insert into consent_record(id,candidate_user_id,consent_text_id) overriding system value values (304,'c3-i5',6),(305,'c3-d1',6);
insert into consent_record(id,portal_user_id,consent_text_id) overriding system value values (306,'c3-pr1',6);
insert into services_case(id,candidate_user_id,permit_type,payer,status,consent_record_id,offer_details,closed_at,close_reason) overriding system value values
 (321,'c3-i5','critical_skills','employer','closed',304,'{"salary":77777}',now()-interval '1 year','decided'),
 (322,'c3-d1','critical_skills','employer','closed',305,'{"salary":88888}',now()-interval '1 year','decided');
insert into services_case(id,portal_user_id,permit_type,payer,status,consent_record_id,offer_details,closed_at,close_reason,dedupe_key) overriding system value values
 (323,'c3-pr1','critical_skills','employer','closed',306,'{"salary":99999}',now()-interval '1 year','decided','k323');
insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) values (321,'cases/321/a.pdf','a.pdf','application/pdf',1,'c3-i5'),(322,'cases/322/a.pdf','a.pdf','application/pdf',1,'c3-d1');
insert into contact_message(id,surface,candidate_user_id,from_name,from_email,topic,body,status,created_at,closed_at) overriding system value values
 (11,'candidate_site','c3-i5','Name I5','c3-i5@example.test','general','my phone is 0851234567','closed',now()-interval '3 months',now()-interval '2 months'),
 (12,'candidate_site','c3-d1','Name D1','c3-d1@example.test','general','my phone is 0851234567','closed',now()-interval '3 months',now()-interval '2 months');
insert into contact_message(id,surface,portal_user_id,from_name,from_email,topic,body,status,created_at,closed_at) overriding system value values
 (13,'portal','c3-pr1','Name PR1','c3-pr1@example.test','general','my phone is 0851234567','closed',now()-interval '3 months',now()-interval '2 months');
insert into email_outbox(id,template,candidate_user_id,portal_user_id,params,dedupe_key,status,send_after,sent_at) overriding system value values
 (21,'alert','c3-i5',null,'{"a":1}','p21','sent',now()-interval '5 days',now()-interval '5 days'),
 (22,'alert','c3-i5',null,'{"a":1}','p22','pending',now(),null),
 (23,'alert','c3-d1',null,'{"a":1}','p23','sent',now()-interval '5 days',now()-interval '5 days'),
 (24,'alert','c3-d1',null,'{"a":1}','p24','failed',now()-interval '5 days',null),
 (25,'invite',null,'c3-pr1','{"a":1}','p25','sent',now()-interval '5 days',now()-interval '5 days'),
 (26,'invite',null,'c3-pr1','{"a":1}','p26','pending',now(),null),
 (27,'alert','c3-i5',null,'{"a":1}','p27','sending',now()-interval '1 day',null);
insert into audit_event(kind,actor_candidate_user_id,action,object_type,object_id,source) values ('security','c3-i5','signin','candidate_user','c3-i5','site'),('security','c3-d1','signin','candidate_user','c3-d1','site');
insert into audit_event(kind,actor_staff_user_id,action,object_type,object_id,subject_candidate_user_id,source) values ('data_access','c3-st1','profile.view','candidate_user','c3-i5','c3-i5','panel');
insert into audit_event(kind,actor_portal_user_id,action,object_type,object_id,source) values ('security','c3-pr1','signin','portal_user','c3-pr1','site');

-- ban evidence reports, job links
insert into report(id,target_kind,target_job_id,reason,status,decided_at,decided_by_staff_user_id) overriding system value values
 (6,'job',1010,'other','upheld',now()-interval '30 months','c3-st1'),(7,'job',1010,'other','upheld',now()-interval '30 months','c3-st1');
update strike set report_id = 6 where id = 6; update strike set report_id = 7 where id = 8;
insert into job_daily_stat(job_id,day,views,apply_clicks) values (1202,current_date,1,1);
insert into job_text(job_id,advert_text) values (1202,'old text');
insert into consent_record(id,candidate_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values (310,'c3-k1',4,1202,6,'{"x":1}');
insert into review_item(id,queue,job_id,status,decided_at,created_at,outcome) overriding system value values (1005,'scam_flag',1202,'done',now()-interval '1 month',now()-interval '2 months','x');
select c3t.fixseq();
