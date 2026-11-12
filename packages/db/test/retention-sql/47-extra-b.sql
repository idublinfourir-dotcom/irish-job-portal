-- C3 extra tests B: erase_candidate, erase_portal_user, visitor message. Run as postgres in c3 after 47-extra-a.sql.
\set ON_ERROR_STOP 0
set session_replication_role = replica;
-- candidate with everything
select c3t.mkc('c3-ks'); select c3t.mkprof('c3-ks');
insert into saved_job(candidate_user_id,job_id) values ('c3-ks',1010);
insert into alert(candidate_user_id,frequency,unsubscribe_token) values ('c3-ks','daily','tok-ks');
insert into notification(candidate_user_id,category,template_key,dedupe_key) values ('c3-ks','x','t','ks-n1');
insert into notification_preference(candidate_user_id,category,channel,enabled) values ('c3-ks','job_alerts','email',false);
insert into candidate_hidden_organisation(candidate_user_id,organisation_id) values ('c3-ks',4);
insert into apply_click(candidate_user_id,job_id,status) values ('c3-ks',1010,'pending');
insert into consent_record(id,candidate_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values (401,'c3-ks',4,1003,4,'{"x":1}'),(402,'c3-ks',5,null,4,'{"x":1}'),(403,'c3-ks',6,null,null,null),(404,'c3-ks',3,null,null,null);
insert into application(id,job_id,organisation_id,candidate_user_id,status,cover_note,answers,profile_summary,cv_storage_key,cv_file_name,consent_record_id) overriding system value values (401,1003,4,'c3-ks','applied','n','{"a":1}','{"p":1}','applications/401/cv.pdf','cv.pdf',401);
insert into message(id,application_id,sender_candidate_user_id,body) overriding system value values (401,401,'c3-ks','from candidate');
insert into message(id,application_id,sender_membership_id,body) overriding system value values (402,401,14,'from employer');
insert into tracker_entry(candidate_user_id,job_id,route,origin,stage,application_id) values ('c3-ks',1003,'on_site','on_site','applied',401);
insert into contact_request(id,organisation_id,membership_id,candidate_user_id,status,sent_at,answered_at,consent_record_id,released_details) overriding system value values (601,4,14,'c3-ks','accepted',now(),now(),402,'{"email":"x@y.z"}');
insert into message(id,contact_request_id,sender_candidate_user_id,body) overriding system value values (403,601,'c3-ks','hi from candidate');
insert into contact_message(id,surface,candidate_user_id,from_name,from_email,topic,body,status,created_at) overriding system value values (21,'candidate_site','c3-ks','KS','c3-ks@example.test','data_request','please erase me, tel 085','new',now());
insert into review_item(id,queue,contact_message_id,status,created_at) overriding system value values (1101,'data_request',21,'open',now());
insert into report(id,target_kind,target_job_id,reporter_candidate_user_id,reason,status) overriding system value values (411,'job',1010,'c3-ks','other','open');           -- ks as reporter
insert into report(id,target_kind,target_message_id,reporter_portal_user_id,reason,status) overriding system value values (412,'message',403,'c3-pm4','other','open');     -- report on ks's message
insert into report(id,target_kind,target_candidate_user_id,reason,status,decided_at) overriding system value values (413,'profile','c3-ks','other','cleared',now());          -- closed report on the profile
insert into services_case(id,candidate_user_id,permit_type,payer,status,consent_record_id,offer_details,closed_at,close_reason) overriding system value values (431,'c3-ks','critical_skills','employer','closed',403,'{"salary":12345}',now(),'decided');
insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) values (431,'cases/431/a.pdf','a.pdf','application/pdf',1,'c3-ks');
insert into email_outbox(template,candidate_user_id,params,dedupe_key,status,send_after,sent_at) values ('alert','c3-ks','{"a":1}','ks-e1','pending',now(),null),('alert','c3-ks','{"a":1}','ks-e2','sent',now(),now()),('alert','c3-ks','{"a":1}','ks-e3','failed',now(),null),('alert','c3-ks','{"a":1}','ks-e4','dropped',now(),null),('alert','c3-ks','{"a":1}','ks-e5','sending',now(),null);
insert into audit_event(kind,actor_candidate_user_id,action,object_type,object_id,source) values ('security','c3-ks','signin','candidate_user','c3-ks','site');
insert into audit_event(kind,actor_staff_user_id,action,object_type,object_id,subject_candidate_user_id,source) values ('data_access','c3-st1','profile.view','candidate_user','c3-ks','c3-ks','panel');
-- candidate with an open case only (refusal); same with open report only
select c3t.mkc('c3-kc'); select c3t.mkc('c3-kr');
insert into consent_record(id,candidate_user_id,consent_text_id) overriding system value values (405,'c3-kc',6);
insert into services_case(id,candidate_user_id,permit_type,payer,status,consent_record_id) overriding system value values (432,'c3-kc','critical_skills','employer','documents_needed',405);
insert into report(id,target_kind,target_candidate_user_id,reason,status) overriding system value values (414,'profile','c3-kr','other','job_hidden');
-- portal user with everything: owner of org 5 alone, signer, posted jobs, invited someone, consent, cases, reports, contact message
insert into organisation(id,slug,display_name,kind,status,signup_path,claimed_at,verified_at,status_changed_at,permit_history) overriding system value values (13,'c3-org-13','C3 Org 13','employer','verified','first_time',now(),now(),now(),'not_linked');
select c3t.mkp('c3-pks');
update membership set portal_user_id = null where false;
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values (60,13,'c3-pks','account_owner','active',true,now());
insert into membership(id,organisation_id,invited_email,invited_by_membership_id,invite_token_hash,invite_expires_at,role,status) overriding system value values (61,13,'invitee@example.test',60,'hash',now()+interval '7 days','recruiter','invited');
insert into consent_record(id,portal_user_id,consent_text_id,job_id,organisation_id,details) overriding system value values (411,'c3-pks',8,1010,13,'{"x":1}'),(412,'c3-pks',6,null,null,null);
insert into services_case(id,portal_user_id,permit_type,payer,status,consent_record_id,offer_details,closed_at,close_reason,dedupe_key) overriding system value values (441,'c3-pks','critical_skills','employer','closed',412,'{"salary":54321}',now(),'decided','dk441');
insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,portal_user_id) values (441,'cases/441/a.pdf','a.pdf','application/pdf',1,'c3-pks');
insert into report(id,target_kind,target_job_id,reporter_portal_user_id,reason,status) overriding system value values (421,'job',1010,'c3-pks','other','open');
insert into contact_message(id,surface,portal_user_id,from_name,from_email,topic,body,status,created_at) overriding system value values (22,'portal','c3-pks','PKS','c3-pks@example.test','data_request','erase me, tel 085','new',now());
insert into review_item(id,queue,contact_message_id,status,created_at) overriding system value values (1102,'data_request',22,'open',now());
insert into notification(portal_user_id,category,template_key,dedupe_key) values ('c3-pks','x','t','pks-n1');
insert into email_outbox(template,portal_user_id,params,dedupe_key,status,send_after,sent_at) values ('invite','c3-pks','{"a":1}','pks-e1','pending',now(),null),('invite','c3-pks','{"a":1}','pks-e2','sent',now(),now()),('invite','c3-pks','{"a":1}','pks-e3','sending',now(),null);
select c3t.mkjob(1450, 13, 'closed', now()); update job set posted_by_membership_id = 60 where id = 1450;
-- portal users that must be refused
select c3t.mkp('c3-pcase'); insert into membership(id,organisation_id,portal_user_id,role,status,joined_at) overriding system value values (62,11,'c3-pcase','recruiter','active',now());
insert into consent_record(id,portal_user_id,consent_text_id) overriding system value values (413,'c3-pcase',6);
insert into services_case(id,portal_user_id,permit_type,payer,status,consent_record_id,dedupe_key) overriding system value values (442,'c3-pcase','critical_skills','employer','received',413,'dk442');
select c3t.mkp('c3-powner'); select c3t.mkp('c3-pother');
insert into membership(id,organisation_id,portal_user_id,role,status,is_signer,joined_at) overriding system value values (63,12,'c3-powner','account_owner','active',true,now()),(64,12,'c3-pother','recruiter','active',false,now());
-- visitor messages
insert into contact_message(id,surface,from_name,from_email,topic,body,status,created_at) overriding system value values (31,'candidate_site','Vis','vis@example.test','data_request','my phone 085','new',now()),(32,'candidate_site','Vis','vis@example.test','general','another','answered',now()),(33,'candidate_site','Other','other@example.test','general','keep me','new',now());
insert into email_outbox(template,contact_message_id,params,dedupe_key,status,send_after,sent_at) values ('contact-reply',31,'{"text":"reply to vis"}','vr-1','pending',now(),null),('contact-reply',32,'{"text":"reply to vis"}','vr-2','sent',now(),now());
select c3t.fixseq();
reset session_replication_role;
\echo ---- results
set role app_admin;
select 'erase ks #1: '||private.erase_candidate('c3-ks', true)::text;
select 'erase ks #2 (again): '||private.erase_candidate('c3-ks', true)::text;
select 'erase kc (open case): '||private.erase_candidate('c3-kc', true)::text;
select 'erase kr (open report): '||private.erase_candidate('c3-kr', true)::text;
select 'erase pcase (open case): '||private.erase_portal_user('c3-pcase', true)::text;
select 'erase powner (owner with other member): '||private.erase_portal_user('c3-powner', true)::text;
select 'erase pks: '||private.erase_portal_user('c3-pks', true)::text;
select 'erase pks again: '||private.erase_portal_user('c3-pks', true)::text;
-- visitor erasure as app_admin: empty name, address and body by email
begin; update contact_message set from_name = null, from_email = null, body = null where from_email = 'vis@example.test'; commit;
reset role;
select c3t.chk('ks','candidate row, login rows and owned rows gone', $$ select not exists(select 1 from candidate_user where id='c3-ks') and not exists(select 1 from candidate_session where user_id='c3-ks') and not exists(select 1 from candidate_account where user_id='c3-ks') and not exists(select 1 from candidate_verification where value='c3-ks') and not exists(select 1 from candidate_profile where candidate_user_id='c3-ks') and not exists(select 1 from candidate_cv where candidate_user_id='c3-ks') and not exists(select 1 from saved_job where candidate_user_id='c3-ks') and not exists(select 1 from alert where candidate_user_id='c3-ks') and not exists(select 1 from notification where candidate_user_id='c3-ks') and not exists(select 1 from apply_click where candidate_user_id='c3-ks') $$);
select c3t.chk('ks','application kept as job/date/outcome with no personal details, its messages gone, tracker link emptied', $$ select (select candidate_user_id is null and cover_note is null and answers is null and profile_summary is null and cv_storage_key is null and consent_record_id is null from application where id=401) and not exists(select 1 from message where id in (401,402,403)) $$);
select c3t.chk('ks','consent records are bare proof with erased stamp', $$ select (select count(*) from consent_record where id between 401 and 404 and subject_erased_at is not null and job_id is null and organisation_id is null and details is null)=4 $$);
select c3t.chk('ks','contact_request kept with released details emptied and no person', $$ select candidate_user_id is null and released_details is null from contact_request where id=601 $$);
select c3t.chk('ks','closed case kept: offer_details kept, requester_erased_at set, document copy gone', $$ select (select offer_details->>'salary'='12345' and requester_erased_at is not null and candidate_user_id is null from services_case where id=431) and (select storage_key is null and copy_deleted_at is not null from case_document where services_case_id=431) $$);
select c3t.chk('ks','contact message kept, request erasure: body, name, address, person all empty', $$ select from_name is null and from_email is null and body is null and candidate_user_id is null from contact_message where id=21 $$);
select c3t.chk('ks','its data_request review item closed, no person left on it', $$ select status='done' and candidate_user_id is null and contact_message_id is null from review_item where id=1101 $$);
select c3t.chk('ks','reports: filed report wiped, report on the message wiped, report on the profile wiped', $$ select (select reporter_wiped_at is not null and reporter_candidate_user_id is null from report where id=411) and (select target_wiped_at is not null and target_message_id is null from report where id=412) and (select target_wiped_at is not null and target_candidate_user_id is null from report where id=413) $$);
select c3t.chk('ks','outbox: pending deleted; sending, sent, failed, dropped kept with stand-in id and no params', $$ select not exists(select 1 from email_outbox where dedupe_key='ks-e1') and (select count(*) from email_outbox where dedupe_key in ('ks-e2','ks-e3','ks-e4','ks-e5') and candidate_user_id like 'erased-%' and params is null)=4 and not exists(select 1 from email_outbox where candidate_user_id='c3-ks') $$);
select c3t.chk('ks','audit log: no row names c3-ks', $$ select not exists(select 1 from audit_event a where a::text like '%c3-ks%') $$);
select c3t.chk('ks','second call on an erased id returns not_found, nothing else', $$ select true $$);
select c3t.chk('refuse','open services case refuses erase_candidate and changes nothing', $$ select exists(select 1 from candidate_user where id='c3-kc') and exists(select 1 from candidate_session where user_id='c3-kc') and (select status='documents_needed' and requester_erased_at is null from services_case where id=432) $$);
select c3t.chk('refuse','open report on the profile refuses erase_candidate', $$ select exists(select 1 from candidate_user where id='c3-kr') $$);
select c3t.chk('refuse','open services case refuses erase_portal_user', $$ select exists(select 1 from portal_user where id='c3-pcase') and exists(select 1 from membership where id=62 and status='active') $$);
select c3t.chk('refuse','owner with other active members refuses erase_portal_user', $$ select exists(select 1 from portal_user where id='c3-powner') and exists(select 1 from membership where id=63 and status='active') $$);
select c3t.chk('pks','portal user, logins and notifications gone; membership removed, person key empty', $$ select not exists(select 1 from portal_user where id='c3-pks') and not exists(select 1 from portal_session where user_id='c3-pks') and (select status='removed' and portal_user_id is null from membership where id=60) and not exists(select 1 from notification where dedupe_key='pks-n1') $$);
select c3t.chk('pks','consent bare proof, case kept with offer_details, document copy gone, report wiped', $$ select (select count(*) from consent_record where id in (411,412) and subject_erased_at is not null and job_id is null and details is null)=2 and (select offer_details->>'salary'='54321' and requester_erased_at is not null from services_case where id=441) and (select storage_key is null from case_document where services_case_id=441) and (select reporter_wiped_at is not null from report where id=421) $$);
select c3t.chk('pks','contact message: request erasure empties body, name, address, person; review item closed', $$ select (select body is null and from_name is null and from_email is null and portal_user_id is null from contact_message where id=22) and (select status='done' and portal_user_id is null from review_item where id=1102) $$);
select c3t.chk('pks','outbox: pending deleted, sent and sending kept with stand-in id and no params', $$ select not exists(select 1 from email_outbox where dedupe_key='pks-e1') and (select count(*) from email_outbox where dedupe_key in ('pks-e2','pks-e3') and portal_user_id like 'erased-%' and params is null)=2 $$);
select c3t.chk('pks','job posted by the erased member still stands with its membership id', $$ select posted_by_membership_id=60 from job where id=1450 $$);
select c3t.chk('pks','audit log: no row names c3-pks', $$ select not exists(select 1 from audit_event a where a::text like '%c3-pks%') $$);
select c3t.chk('visitor','visitor erasure by email empties name, address and body on every message of that address', $$ select (select count(*) from contact_message where id in (31,32) and from_name is null and from_email is null and body is null)=2 $$);
select c3t.chk('visitor','another visitor''s message untouched', $$ select from_email='other@example.test' and body='keep me' from contact_message where id=33 $$);
select grp, count(*) filter (where ok) as pass, count(*) filter (where not ok) as fail from c3t.result where grp in ('ks','refuse','pks','visitor') group by grp order by 1;
select 'FAIL: ' || name || ' | ' || left(detail,200) from c3t.result where not ok and grp in ('ks','refuse','pks','visitor') order by n;
