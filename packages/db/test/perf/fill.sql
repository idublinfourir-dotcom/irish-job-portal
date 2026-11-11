-- Fake fill at full size for the page gate. Fake data only: nothing here comes from a real advert or a real company.
-- Counts follow the third trial's fill (schema-trial-3/40-load.sql): 5,000 live jobs in 38,000 job rows, 50,000 candidates,
-- 1,000 verified organisations plus 6,359 unclaimed ones, 115,565 register companies. Launch A tables only.
-- :cand and :orgs are replaced by fill.ts. A line that is only "-- @@" splits the file into steps run one after another on one connection.
-- Run as postgres with session_replication_role = replica, so triggers and foreign key checks are off for speed (CHECK constraints still run).
--
-- Advert text. The width of job.search_vector and job_text drives the page counts, so the fake adverts match the sizes measured on the
-- trial's 5,000 real adverts (trial-data/live.csv, measured 10 November 2026, nothing copied):
--   * 5,000 adverts but only 1,236 distinct texts, each used about four times (3 times: 66 texts, 4: 1,145, 8 or more: 25).
--   * advert text: mean 5,444 characters, 766 whitespace words; title: mean 42 characters; employer: 164 distinct names, mean 12 characters.
--   * search_vector (title + employer + "FakeCo n" + text): mean 293 distinct lexemes (p10 151, p50 300, p90 412), mean 4,752 bytes
--     (p10 2,356, p90 6,740), mean 532 positions, about 14,600 distinct lexemes over the 1,236 texts.
--   * 324 of the 5,000 state a salary (lows from 31,000, median low 69,000, median high 80,000).
--   * counties: Dublin 41 per cent down to Leitrim 12 jobs; sectors: other 2,069, IT 1,288, health 800, pharma 455, construction 332, finance 56.
--   * posted between 3.7 and 33.7 days ago.
-- The fake words are made-up consonant and vowel syllables (nothing a stemmer or stop list touches), drawn from a skewed vocabulary:
-- rank = floor(exp(ln(7500) * u^1.5)), 5 words per advert that no other advert has, and stop words sprinkled in for the text length.
-- fill.ts prints the measured sizes of the generated fill, so a drift from the numbers above shows in the test log.
select setseed(0.42);

create function pg_temp.fakeword(r int) returns text language sql immutable as $$
  select string_agg(substr('bdfgklmnprstvz', 1 + ((r / p) % 70) / 5, 1) || substr('aeiou', 1 + ((r / p) % 70) % 5, 1), '') from unnest(array[1,70,4900]) p $$;

create temp table fake_ad as
 with d as (select g as d, greatest(30, round(660 + 220 * sqrt(-2*ln(1-random())) * cos(2*pi()*random())))::int n, random() rc, random() rs, random() pay, random() emp, random() rt from generate_series(1,1236) g),
 w as (select d.d, i, floor(exp(ln(7500) * power(random(), 1.5)))::int r, random() < 0.55 as stop from d cross join lateral generate_series(1, d.n) i
       union all select d.d, 100000 + k, 100000 + d.d * 8 + k, false from d cross join generate_series(1,5) k),
 t as (select d, string_agg(concat(pg_temp.fakeword(r), case when stop then ' ' || (array['the','and','of','to','a','in','for','with','is','are','on','as','be','will'])[1 + floor(random()*14)::int] end), ' ' order by i) txt from w group by d),
 ti as (select d.d, initcap(string_agg(pg_temp.fakeword(floor(exp(ln(3000) * random()))::int), ' ')) title from d cross join lateral generate_series(1, 4 + floor(d.rt*5)::int) k group by d.d),
 cw(c, w) as (values ('Dublin',2050),('Cork',603),('Galway',281),('Kildare',216),('Limerick',212),('Waterford',168),('Meath',157),('Wicklow',139),('Tipperary',115),('Wexford',108),('Mayo',101),('Donegal',97),('Kerry',94),('Louth',92),('Clare',68),('Carlow',58),('Roscommon',57),('Kilkenny',56),('Laois',54),('Sligo',51),('Monaghan',46),('Offaly',45),('Westmeath',45),('Cavan',42),('Longford',33),('Leitrim',12)),
 cc as (select c, sum(w) over (order by w desc, c)::float / sum(w) over () cum from cw),
 sw(s, w) as (values ('other',2069),('IT',1288),('health',800),('pharma and science',455),('construction and engineering',332),('finance',56)),
 sc as (select s, sum(w) over (order by w desc, s)::float / sum(w) over () cum from sw)
 select d.d, ti.title, 'Fake Employer ' || (1 + floor(power(d.emp, 2) * 164))::int employer,
   (select c from cc where cum >= d.rc order by cum limit 1) county, (select s from sc where cum >= d.rs order by cum limit 1) sector,
   case when d.pay < 0.0648 then 31000 + floor(random()*75)::int * 1000 end lo, t.txt
 from d join t using (d) join ti using (d);
alter table fake_ad add column hi int;
update fake_ad set hi = lo + 2000 + floor(random()*20)::int * 1000 where lo is not null;

create temp table imp_live as
 select a.title, a.employer, a.county, a.sector, a.lo, a.hi, now() - (3.7 + random() * 30) * interval '1 day' posted, a.txt
 from generate_series(1,5000) i join fake_ad a on a.d = 1 + ((i - 1) % 1236);
create temp table imp_dete as
 select 'Fake Unclaimed Employer ' || g || ' Limited' as name, 'fake unclaimed employer ' || g as norm, case when g % 10 = 0 then 0 else 1 + floor(power(random(), 3) * 289)::int end as n from generate_series(1,6359) g;
-- @@
insert into organisation(slug,display_name,kind,status,signup_path,claimed_at,verified_at,website,short_description,county,permit_history,is_big_company,cro_number)
 select 'org-'||g, 'Fake Company '||g, 'employer','verified','dete_claim',now(),now(),'https://example'||g||'.test','A fake company with a short description of about this long, for size only.','Dublin',
   (array['has_history','has_history','first_time','not_linked'])[1+g%4], g%50=0, lpad(g::text,6,'0') from generate_series(1,:orgs) g;
insert into organisation(slug,display_name,kind,status,permit_history) select 'dete-'||row_number() over (), d.name, 'employer','unclaimed',case when d.n>0 then 'has_history' else 'not_linked' end from imp_dete d;
insert into organisation_name(organisation_id,name,normalised_name,kind,source)
 select :orgs + row_number() over (), d.name, d.norm, 'legal','dete' from imp_dete d on conflict do nothing;
insert into organisation_name(organisation_id,name,normalised_name,kind,source,cro_number) select g,'Fake Company '||g,'fake company '||g,'legal','cro',lpad(g::text,6,'0') from generate_series(1,:orgs) g;
insert into organisation_name(organisation_id,name,normalised_name,kind,source) select g,'FakeCo '||g,'fakeco '||g,'alias','job_site' from generate_series(1,:orgs) g;
insert into dete_permit_count(dete_name,organisation_name_id,year,permits,source_file)
 select d.name, n.id, y, greatest(1,d.n/8), 'fake-'||y||'.xlsx' from imp_dete d left join organisation_name n on n.normalised_name=d.norm and n.kind='legal' and n.cro_number is null cross join generate_series(2019,2026) y on conflict do nothing;
insert into organisation_domain(organisation_id,domain,source) select g,'example'||g||'.test','seed' from generate_series(1,:orgs) g;
insert into wrc_licence(licence_number,agency_name,trading_name,address,county,first_seen_on,last_seen_on) select 'WRC'||g,'Fake Agency '||g,'Fake '||g,g||' Fake Street, Dublin','Dublin','2026-01-01','2026-11-01' from generate_series(1,600) g;
-- 115,565 Normal companies, the count the design gives (PRD section 15)
insert into cro_company(cro_number,name,normalised_name,status,last_seen_on)
 select lpad((100000+g)::text,7,'0'), 'Fake Register Company '||g||' Limited', 'fake register company '||g, 'Normal', current_date from generate_series(1,115565) g;
-- @@
-- people
create temp table cand as select g, 'cand'||lpad(g::text,7,'0')||'x0123456789abcdef' as id from generate_series(1,:cand) g;
insert into candidate_user(id,name,email,email_verified,created_at,updated_at,last_active_at) select id,'Fake Person '||g,'fake.person.'||g||'@example.test',true,now(),now(),now()-(g%300||' days')::interval from cand;
insert into candidate_account(id,account_id,provider_id,user_id,password,created_at,updated_at) select 'acct'||id,id,'credential',id,repeat(md5(id),5),now(),now() from cand;
insert into candidate_session(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id) select 'sess'||id,now()+interval '7 days','tok'||md5(id)||md5(id||'x'),now(),now(),'203.0.113.'||(g%250),'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/128.0 Mobile Safari/537.36',id from cand where g%5=0;
insert into candidate_verification(id,identifier,value,expires_at,created_at,updated_at) select 'ver'||id,'reset-password:'||md5(id),id,now()+interval '1 hour',now(),now() from cand where g%100=0;
insert into candidate_rate_limit(id,key,count,last_request) select 'rl'||g,'203.0.'||(g/250)||'.'||(g%250)||'|/sign-in/email',1+g%5,(extract(epoch from now())*1000)::bigint from generate_series(1,greatest(200,:cand/25)) g;
insert into candidate_profile(candidate_user_id,full_name,phone,occupation_code,years_experience,has_relevant_degree,degree_field,degree_awarded_month,registration_body,registration_status,location_kind,current_stamp)
 select id,'Fake Person '||g,'+35300000'||(g%1000),'2231',g%30,true,'Fake nursing degree','2020-06-01','NMBI','in_progress',case when g%3=0 then 'ireland' else 'abroad' end,case when g%3=0 then '1G' end from cand;
insert into candidate_cv(candidate_user_id,storage_key,file_name,content_type,size_bytes) select id,'cv/'||id||'/current.pdf','fake-cv-'||g||'.pdf','pdf',300000 from cand where g%2=0;
insert into alert(candidate_user_id,occupation_code,sector,county,salary_min,search_text,frequency,unsubscribe_token)
 select id,'2231',(array['health','IT','finance'])[1+g%3],case when g%4=0 then 'Dublin' end,case when g%5=0 then 45000 end,
   case when g%2=0 then (array['nurse','software engineer','accountant','civil engineer','pharmacist','data analyst','care assistant','process engineer','customer support','project manager'])[1+g%10] end,
   case when g%3=0 then 'daily' else 'weekly' end, md5(id||'unsub') from cand where g%10<6;
create temp table por as select g, 'port'||lpad(g::text,7,'0')||'x0123456789abcdef' as id from generate_series(1,:orgs*2) g;
insert into portal_user(id,name,email,email_verified,created_at,updated_at) select id,'Fake Member '||g,'fake.member.'||g||'@example'||((g+1)/2)||'.test',true,now(),now() from por;
insert into portal_account(id,account_id,provider_id,user_id,password,created_at,updated_at) select 'acct'||id,id,'credential',id,repeat(md5(id),5),now(),now() from por;
insert into portal_session(id,expires_at,token,created_at,updated_at,ip_address,user_agent,user_id) select 'sess'||id,now()+interval '7 days','tok'||md5(id)||md5(id||'x'),now(),now(),'203.0.113.'||(g%250),'Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0 Safari/537.36',id from por where g%4=0;
insert into portal_rate_limit(id,key,count,last_request) select 'rl'||g,'198.51.'||(g/250)||'.'||(g%250)||'|/sign-in/email',1,(extract(epoch from now())*1000)::bigint from generate_series(1,greatest(20,:orgs/5)) g;
insert into membership(organisation_id,portal_user_id,role,status,is_signer,joined_at) select (g+1)/2,id,case when g%2=1 then 'account_owner' else 'recruiter' end,'active',g%2=1,now() from por;
create temp table sta as select g, 'staf'||lpad(g::text,7,'0')||'x0123456789abcdef' as id from generate_series(1,greatest(5,:cand/3334)) g;
insert into staff_user(id,name,email,email_verified,created_at,updated_at) select id,'Fake Staff '||g,'fake.staff.'||g||'@example.test',true,now(),now() from sta;
insert into staff_account(id,account_id,provider_id,user_id,password,created_at,updated_at) select 'acct'||id,id,'credential',id,repeat(md5(id),5),now(),now() from sta;
insert into staff_session(id,expires_at,token,created_at,updated_at,user_id) select 'sess'||id,now()+interval '7 days','tok'||md5(id),now(),now(),id from sta;
insert into staff_rate_limit(id,key,count,last_request) select 'rl'||g,'192.0.2.'||g||'|/sign-in/email',1,(extract(epoch from now())*1000)::bigint from generate_series(1,20) g;
insert into staff_role(staff_user_id,role,seeded_by_owner) select id,(array['account_reviewer','fetched_job_reviewer','rules_data_editor','trust_and_safety','services_case_handler','content_editor','administrator'])[1+g%7],true from sta;
-- @@
-- jobs: 5,000 live from fake adverts, 33,000 closed mixed in, adverts linked at insert
insert into job_source(kind,board) select 'board','fake-board-'||g from generate_series(1,29) g; insert into job_source(kind,board) values ('portal','portal');
create temp table mix as
 select row_number() over () rn, * from (
  select title,employer,county,sector,lo,hi,posted,txt,'live'::text st,random() r from imp_live
  union all select title,employer,county,sector,null,null,now()-(random()*interval '30 days'),null,'closed',random() from imp_live limit 10000) a order by r;
insert into fetched_advert(job_source_id,external_id,url,title,employer_name,first_seen_at,last_seen_at,result,stage,quoted_evidence,matcher_model)
 select 1+(g%29),'ext-'||g,'https://jobs.example.test/fake/board/'||g,'A fake advert title of normal length '||g,'Fake Employer '||(g%500),now()-interval '60 days',now(),'rejected','5 occupation not recognised','Short quoted evidence from the advert, about two hundred characters long, kept for review as number 122 asks. Short quoted evidence from the advert, about two hundred characters long.','free-model-1' from generate_series(1,60000) g;
insert into fetched_advert(job_source_id,external_id,url,title,employer_name,result,stage,matcher_model)
 select 1+(g%29),'old-'||g,'https://jobs.example.test/fake/closed/'||g,'A fake closed job title '||g,'Fake Employer '||(g%500),'passed','PASS','free-model-1' from generate_series(1,28000) g;
insert into job(organisation_id,source,job_source_id,fetched_advert_id,title,employer_name,sector,county,permit_type,badge,pass_route,status,posted_at,closes_at,closed_at,own_page_url,permit_history)
 select 1+(g%(:orgs+6000)),'fetched',1+(g%29),(select min(id) from fetched_advert where result='passed')+g-1,'A fake closed job title '||g,'Fake Employer '||(g%500),(array['IT','health','finance','pharma and science','construction and engineering'])[1+g%5],'Dublin','critical_skills','critical_skills_eligible','stated_pay','closed',now()-interval '2 years'+(g||' minutes')::interval,'infinity',now()-interval '1 year','https://jobs.example.test/fake/closed/'||g,(array['has_history','first_time','not_linked'])[1+g%3] from generate_series(1,28000) g;
insert into fetched_advert(job_source_id,external_id,url,title,employer_name,result,stage,matcher_model)
 select 1+(rn%29),'mix-'||rn,'https://jobs.example.test/fake/'||rn,title,employer,'passed','PASS','free-model-1' from mix where rn%5<>0 order by rn;
create temp table mixadv as select f.id fid, substr(f.external_id,5)::bigint rn from fetched_advert f where f.external_id like 'mix-%';
-- Employer jobs (every fifth) stand behind one of the verified organisations and are posted by its account owner, so each live sponsor_confirmed job can get its statement below.
create temp table mixorg as select rn, case when rn%5=0 then 1+(rn%:orgs) else 1+(rn%(:orgs+6000)) end oid from mix;
insert into job(organisation_id,source,job_source_id,fetched_advert_id,title,employer_name,sector,county,permit_type,badge,pass_route,salary_low,salary_high,pay_grade,status,posted_at,closes_at,closed_at,own_page_url,permit_history,quota_full,search_vector,posted_by_membership_id)
 select o.oid,case when m.rn%5=0 then 'employer' else 'fetched' end,case when m.rn%5=0 then 30 else 1+(m.rn%29) end,a.fid,m.title,m.employer,m.sector,m.county,
   case when m.rn%5=0 and m.rn%3=0 then 'general' else 'critical_skills' end,
   case when m.rn%5=0 then 'sponsor_confirmed' else 'critical_skills_eligible' end,'stated_pay',
   case when m.rn%5=0 then coalesce(m.lo, 32000+(m.rn%40)*1000) else m.lo end, m.hi, null, m.st, m.posted,
   case when m.rn%5<>0 then 'infinity'::timestamptz when m.st='live' then now()+interval '30 days' else m.posted+interval '30 days' end,
   case when m.st='closed' then now()-interval '1 day' end,'https://jobs.example.test/fake/'||m.rn,(array['has_history','has_history','first_time','not_linked'])[1+m.rn%4], m.st='live' and m.rn%100=0,
   case when m.st='live' then to_tsvector('english',m.title||' '||m.employer||' FakeCo '||o.oid||' '||m.txt) end,
   case when m.rn%5=0 then 2*o.oid-1 end
 from mix m join mixorg o using (rn) left join mixadv a on a.rn=m.rn order by m.r;
insert into job_text select j.id, i.txt from (select id, row_number() over (order by id) n from job where status='live') j join (select txt, row_number() over (order by r) n from mix where st='live') i using(n);
insert into job_daily_stat(job_id,day,views,apply_clicks) select j.id,current_date-d,(random()*50)::int,(random()*5)::int from (select id from job where source='employer' limit :cand/6) j cross join generate_series(0,29) d;
insert into fetch_run(job_source_id,finished_at,seen,new,closed) select 1+(g%30),now(),100,3,1 from generate_series(1,2700) g;
-- @@
-- candidate records
create temp table livej as select id, organisation_id, row_number() over () n from job where status='live';
insert into saved_job(candidate_user_id,job_id) select c.id,l.id from cand c cross join generate_series(0,2) x join livej l on l.n=1+((c.g*7+x*131)%5000) on conflict do nothing;
insert into tracker_entry(candidate_user_id,job_id,route,origin,stage) select c.id,l.id,'redirect','mark_applied','applied' from cand c cross join generate_series(0,1) x join livej l on l.n=1+((c.g*11+x*97)%5000) on conflict do nothing;
insert into apply_click(candidate_user_id,job_id,status) select c.id,l.id,'pending' from cand c join livej l on l.n=1+(c.g*13%5000) where c.g%5<2 on conflict do nothing;
insert into consent_text(purpose,version,body) select p,'v1',repeat('Fake consent wording. ',40) from unnest(array['signup_terms','privacy_notice','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor']) p;
insert into consent_text(purpose,version,body) select p,'v2',repeat('Fake consent wording. ',40) from unnest(array['signup_terms','privacy_notice','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor']) p;
insert into consent_record(candidate_user_id,consent_text_id,details) select c.id,1+x,'{"source":"signup","version":"v1"}' from cand c cross join generate_series(0,1) x;
create temp table appl as select c.id cid, c.g, l.id jid, l.organisation_id oid, row_number() over () n from cand c cross join generate_series(0,1) x join livej l on l.n=1+((c.g*17+x*53)%5000) where c.g%5<3;
insert into consent_record(candidate_user_id,consent_text_id,job_id,organisation_id,details) select cid,4,jid,oid,'{"shared":["profile","cv","answers"],"employer":"Fake Company"}' from appl;
insert into application(candidate_user_id,job_id,organisation_id,status,cover_note,answers,profile_summary,cv_storage_key,cv_file_name,consent_record_id)
 select a.cid,a.jid,a.oid,'applied',repeat('A fake cover note of normal length. ',20),'{"q1":"A fake answer","q2":"Another fake answer of normal length"}','{"occupation":"2231","years":5,"degree":true,"location":"abroad","registration":"in_progress"}','applications/'||a.n||'/cv.pdf','fake-cv.pdf',(select min(id) from consent_record)+a.n%1000 from appl a on conflict do nothing;
insert into candidate_hidden_organisation(candidate_user_id,organisation_id) select id,1+g%:orgs from cand where g%10=0 on conflict do nothing;
insert into contact_request(organisation_id,membership_id,candidate_user_id,status,sent_at,released_details,consent_record_id) select 1+g%:orgs,1+2*(g%:orgs),id,'accepted',now(),'{"email":"fake@example.test","phone":"+353000"}',(select min(id) from consent_record) from cand where g%10=0;
insert into message(application_id,sender_candidate_user_id,sender_membership_id,body) select a.id,case when a.id%2=0 then a.candidate_user_id end,case when a.id%2=1 then 1 end,repeat('A fake message of normal length. ',10) from application a limit :cand*6/10;
-- employer records
insert into sponsorship_statement(job_id,organisation_id,kind,consent_text_id,signer_membership_id,signer_name,signer_title,signed_at)
 select j.id,j.organisation_id,'own_company',8,m.id,'Fake Signer','Head of People',now() from (select id, organisation_id from job where source='employer' and badge='sponsor_confirmed' and status='live') j join membership m on m.organisation_id=j.organisation_id and m.role='account_owner' on conflict do nothing;
insert into approval_request(kind,target_table,target_id,change,reason,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,applied_at) select 'pay_floor','pay_floor',g::text,'{"floor":50000}','Fake reason',(select id from sta where g=1),(select id from sta where g=2),'confirmed',now(),now() from generate_series(1,:cand/100) g;
insert into pay_floor(organisation_id,role_family,floor_eur,consent_text_id,signer_membership_id,signer_name,signer_title,valid_until,status,approval_request_id) select o.id,'software',60000,9,m.id,'Fake Signer','Head of People',now()+interval '300 days','active',(select min(id) from approval_request) from organisation o join membership m on m.organisation_id=o.id and m.role='account_owner' where o.is_big_company;
-- services, reports, strikes, contact and content
insert into services_case(candidate_user_id,job_id,permit_type,payer,status,consent_record_id,offer_details) select c.id,l.id,'critical_skills','employer','received',(select min(id) from consent_record),'{"salary":40000,"start":"2027-01"}' from cand c join livej l on l.n=1+(c.g%5000) where c.g%25=0 on conflict do nothing;
insert into case_note(services_case_id,author_staff_user_id,body) select s.id,(select id from sta where g=1),repeat('A fake case note. ',8) from services_case s cross join generate_series(1,3);
insert into case_document(services_case_id,storage_key,file_name,content_type,byte_size,candidate_user_id) select s.id,'cases/'||s.id||'/'||x||'.pdf','fake-copy-'||x||'.pdf','application/pdf',200000,s.candidate_user_id from services_case s cross join generate_series(1,3) x;
insert into case_quote(services_case_id,amount_eur,status,invoice_number,organisation_id) select id,900,'paid','INV-'||id,1 from services_case where id%2=0;
insert into report(target_kind,target_job_id,reason,evidence_text,target_snapshot,status,decided_at) select 'job',l.id,'other','Fake evidence of normal length, written by the reporter.','{"title":"Fake job title","employer":"Fake Employer"}','cleared',now() from livej l where l.n<=:cand/25;
insert into strike(organisation_id,case_kind,report_id,reason_code,level,stage,outcome,decided_at,notice_summary) select 1+id%:orgs,'false_claim',id,'false_sponsorship',1,'applied','strike',now(),'Fake summary of what was found, written for the employer.' from report where id<=:cand/500;
insert into approval_request(kind,target_table,target_id,reason,proposed_by_staff_user_id,confirmed_by_staff_user_id,status,decided_at,applied_at) select 'ban','ban',g::text,'Fake reason',(select id from sta where g=1),(select id from sta where g=2),'confirmed',now(),now() from generate_series(1,:cand/1667) g;
insert into ban(cro_number,reason_code,strike_id,approval_request_id) select 'BAN'||g,'fake_job',g,(select min(id) from approval_request where kind='ban')+g-1 from generate_series(1,:cand/1667) g;
insert into approval_request(kind,target_table,target_id,reason,proposed_by_staff_user_id,status) select 'threshold','setting','k'||g,'Fake reason',(select id from sta where g=1),'withdrawn' from generate_series(1,:cand/100) g;
insert into review_item(queue,job_id,reason,detail,status,outcome,decided_at) select 'fetched_job',(select min(id) from job)+g,'Fake reason','{"evidence":"A short quoted line from the fake advert, as the AI step returned it"}','done','approved',now() from generate_series(1,:cand*4/10) g;
insert into contact_message(surface,candidate_user_id,from_name,from_email,topic,body,status,closed_at) select 'candidate_site',id,'Fake Person','fake.person.'||g||'@example.test','general',repeat('A fake contact form message. ',8),'closed',now() from cand where g%20=0;
insert into content_page(kind,slug,title,body,source_url,checked_on,status,published_at,updated_by_staff_user_id)
 select (array['guide','update','help'])[1+g%3],'page-'||g,'A fake page title '||g,repeat('Fake guide text of normal length, written for candidates and employers. ',40),'https://enterprise.gov.ie/','2026-11-01','published',now(),(select id from sta where g=1) from generate_series(1,300) g;
-- @@
-- audit log, scoped to staff actions, data views and security events, kept 24 months
insert into audit_event(at,kind,actor_candidate_user_id,action,object_type,object_id,source) select now()-(g%700||' days')::interval,'security',id,(array['signin_failed','password_reset','email_change'])[1+g%3],'candidate_user',id,'site' from cand cross join generate_series(1,2) x;
insert into audit_event(at,kind,actor_portal_user_id,action,object_type,object_id,source) select now()-((g*7+x)%700||' days')::interval,'security',p.id,'portal.signin','portal_user',p.id,'site' from por p cross join generate_series(1,52) x;
insert into audit_event(at,kind,actor_staff_user_id,role_in_force,action,object_type,object_id,changed_columns,before,after,reason_code,source)
 select now()-(g%700||' days')::interval,'admin_action',(select id from sta where g=1+x%5),'fetched_job_reviewer','job.decide','job',g::text,'{status,badge}','{"status":"in_review"}','{"status":"live","badge":"critical_skills_eligible"}','queue_decision','panel' from generate_series(1,:cand*8/10) g cross join generate_series(1,1) x;
insert into audit_event(at,kind,actor_staff_user_id,role_in_force,action,object_type,object_id,subject_candidate_user_id,reason_code,reason_text,source)
 select now()-(g%700||' days')::interval,'data_access',(select id from sta where g=1),'services_case_handler','profile.view','services_case',(g%(:cand/25+1))::text,'cand'||lpad((1+g%:cand)::text,7,'0')||'x0123456789abcdef','services_case','Fake reason for viewing, typed by staff','panel' from generate_series(1,:cand*8/10) g;
insert into audit_event(at,kind,actor_staff_user_id,action,source) select now()-(g%700||' days')::interval,'security',(select id from sta where g=1+g%5),'staff.signin','panel' from generate_series(1,greatest(1250,:cand/10)) g;
insert into notification_preference(candidate_user_id,category,channel,enabled) select id,'alerts','email',false from cand where g%10=0;
insert into notification(candidate_user_id,category,template_key,params,dedupe_key) select id,'job_closed','job-closed','{"job_id":123456,"title":"A fake job title of normal length"}',md5('n'||g||'-'||x) from cand cross join generate_series(1,2) x;
insert into email_outbox(template,candidate_user_id,params,dedupe_key,status,sent_at) select 'alert-digest','cand'||lpad((1+g%:cand)::text,7,'0')||'x0123456789abcdef','{"alert_id":123456,"job_ids":[1,2,3,4,5,6,7,8]}',md5('e'||g),'sent',now() from generate_series(1,:cand*4) g;
-- @@
-- The sponsor key (migration 0008), set as the refresh function would: -1 with no linked DETE name, else the permits of the last 5 calendar years.
-- Triggers are off in this load, so it is written to the organisations and copied onto their jobs here.
update organisation o set sponsor_sort = s.p
 from (select n.organisation_id id, coalesce(sum(d.permits) filter (where d.year between extract(year from now() at time zone 'utc')::int - 4 and extract(year from now() at time zone 'utc')::int), 0)::int p
         from dete_permit_count d join organisation_name n on n.id = d.organisation_name_id where n.organisation_id is not null group by 1) s
 where s.id = o.id;
update job j set sponsor_sort = o.sponsor_sort from organisation o where o.id = j.organisation_id and o.sponsor_sort <> -1;
