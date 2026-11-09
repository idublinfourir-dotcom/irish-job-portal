-- Tables, indexes and views (design 23). Final state: the build plus every proven fix, in one file.
set role portal_owner;

-- The 15 login tables (5 per pool) as Better Auth 1.7.17 creates them with the design's column mappings
-- (packages/auth). Dumped from a scratch run of its own migration, so they match what the library expects.

CREATE TABLE candidate_account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE TABLE candidate_rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);
CREATE TABLE candidate_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);
CREATE TABLE candidate_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    suspended_at timestamp with time zone,
    deleted_at timestamp with time zone,
    last_active_at timestamp with time zone,
    inactive_warned_at timestamp with time zone
);
CREATE TABLE candidate_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE portal_account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE TABLE portal_rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);
CREATE TABLE portal_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);
CREATE TABLE portal_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status text,
    blocked_at timestamp with time zone,
    blocked_reason_code text,
    last_active_at timestamp with time zone,
    deleted_at timestamp with time zone
);
CREATE TABLE portal_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
CREATE TABLE staff_account (
    id text NOT NULL,
    account_id text NOT NULL,
    provider_id text NOT NULL,
    user_id text NOT NULL,
    access_token text,
    refresh_token text,
    id_token text,
    access_token_expires_at timestamp with time zone,
    refresh_token_expires_at timestamp with time zone,
    scope text,
    password text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL
);
CREATE TABLE staff_rate_limit (
    id text NOT NULL,
    key text NOT NULL,
    count integer NOT NULL,
    last_request bigint NOT NULL
);
CREATE TABLE staff_session (
    id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    token text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    ip_address text,
    user_agent text,
    user_id text NOT NULL
);
CREATE TABLE staff_user (
    id text NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    email_verified boolean NOT NULL,
    image text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status text
);
CREATE TABLE staff_verification (
    id text NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
alter table only candidate_account
    ADD CONSTRAINT candidate_account_pkey PRIMARY KEY (id);
alter table only candidate_rate_limit
    ADD CONSTRAINT candidate_rate_limit_key_key UNIQUE (key);
alter table only candidate_rate_limit
    ADD CONSTRAINT candidate_rate_limit_pkey PRIMARY KEY (id);
alter table only candidate_session
    ADD CONSTRAINT candidate_session_pkey PRIMARY KEY (id);
alter table only candidate_session
    ADD CONSTRAINT candidate_session_token_key UNIQUE (token);
alter table only candidate_user
    ADD CONSTRAINT candidate_user_email_key UNIQUE (email);
alter table only candidate_user
    ADD CONSTRAINT candidate_user_pkey PRIMARY KEY (id);
alter table only candidate_verification
    ADD CONSTRAINT candidate_verification_pkey PRIMARY KEY (id);
alter table only portal_account
    ADD CONSTRAINT portal_account_pkey PRIMARY KEY (id);
alter table only portal_rate_limit
    ADD CONSTRAINT portal_rate_limit_key_key UNIQUE (key);
alter table only portal_rate_limit
    ADD CONSTRAINT portal_rate_limit_pkey PRIMARY KEY (id);
alter table only portal_session
    ADD CONSTRAINT portal_session_pkey PRIMARY KEY (id);
alter table only portal_session
    ADD CONSTRAINT portal_session_token_key UNIQUE (token);
alter table only portal_user
    ADD CONSTRAINT portal_user_email_key UNIQUE (email);
alter table only portal_user
    ADD CONSTRAINT portal_user_pkey PRIMARY KEY (id);
alter table only portal_verification
    ADD CONSTRAINT portal_verification_pkey PRIMARY KEY (id);
alter table only staff_account
    ADD CONSTRAINT staff_account_pkey PRIMARY KEY (id);
alter table only staff_rate_limit
    ADD CONSTRAINT staff_rate_limit_key_key UNIQUE (key);
alter table only staff_rate_limit
    ADD CONSTRAINT staff_rate_limit_pkey PRIMARY KEY (id);
alter table only staff_session
    ADD CONSTRAINT staff_session_pkey PRIMARY KEY (id);
alter table only staff_session
    ADD CONSTRAINT staff_session_token_key UNIQUE (token);
alter table only staff_user
    ADD CONSTRAINT staff_user_email_key UNIQUE (email);
alter table only staff_user
    ADD CONSTRAINT staff_user_pkey PRIMARY KEY (id);
alter table only staff_verification
    ADD CONSTRAINT staff_verification_pkey PRIMARY KEY (id);
CREATE INDEX candidate_account_user_id_idx ON candidate_account USING btree (user_id);
CREATE INDEX candidate_session_user_id_idx ON candidate_session USING btree (user_id);
CREATE INDEX candidate_verification_identifier_idx ON candidate_verification USING btree (identifier);
CREATE INDEX portal_account_user_id_idx ON portal_account USING btree (user_id);
CREATE INDEX portal_session_user_id_idx ON portal_session USING btree (user_id);
CREATE INDEX portal_verification_identifier_idx ON portal_verification USING btree (identifier);
CREATE INDEX staff_account_user_id_idx ON staff_account USING btree (user_id);
CREATE INDEX staff_session_user_id_idx ON staff_session USING btree (user_id);
CREATE INDEX staff_verification_identifier_idx ON staff_verification USING btree (identifier);
alter table only candidate_account
    ADD CONSTRAINT candidate_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES candidate_user(id) ON DELETE CASCADE;
alter table only candidate_session
    ADD CONSTRAINT candidate_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES candidate_user(id) ON DELETE CASCADE;
alter table only portal_account
    ADD CONSTRAINT portal_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES portal_user(id) ON DELETE CASCADE;
alter table only portal_session
    ADD CONSTRAINT portal_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES portal_user(id) ON DELETE CASCADE;
alter table only staff_account
    ADD CONSTRAINT staff_account_user_id_fkey FOREIGN KEY (user_id) REFERENCES staff_user(id) ON DELETE CASCADE;
alter table only staff_session
    ADD CONSTRAINT staff_session_user_id_fkey FOREIGN KEY (user_id) REFERENCES staff_user(id) ON DELETE CASCADE;


-- Trial 3: brought up to 23-database-design.md as it stood on 9 November 2026 after the five rounds of fixes (980 lines). Trial 2 was built from the 826-line text. Run as portal_owner, after
-- Better Auth's migration (01-ba-migrate.mjs) has made the 15 login tables. "PICK:" marks a place where the
-- document does not say, so this file had to choose; each one is also listed in RESULTS.md.

-- ===== Login pools: the added columns are made by Better Auth (additionalFields); checks and indexes here.
alter table portal_user alter column status set default 'active', alter column status set not null,
  add constraint portal_user_status_check check (status in ('active','blocked'));
alter table staff_user alter column status set default 'active', alter column status set not null,
  add constraint staff_user_status_check check (status in ('active','disabled'));
create index candidate_user_active_idx on candidate_user(last_active_at) where deleted_at is null;
create index candidate_user_deleted_idx on candidate_user(deleted_at) where deleted_at is not null;
-- Section 3 (candidate_user): last_active_at defaults to now() in the same insert as created_at; the inactivity sweep tests it alone.
alter table candidate_user alter column last_active_at set default now();
-- Section 2.2: Google sign-in looks an account up by (provider_id, account_id) and assumes at most one row.
alter table candidate_account add constraint candidate_account_provider_unique unique (provider_id, account_id);
alter table portal_account add constraint portal_account_provider_unique unique (provider_id, account_id);
alter table staff_account add constraint staff_account_provider_unique unique (provider_id, account_id);
-- Section 7, retention indexes on the login tables (Better Auth makes the tables; these serve run_retention).
create index candidate_user_unverified_idx on candidate_user(created_at) where email_verified = false;
create index candidate_user_warned_idx on candidate_user(inactive_warned_at) where inactive_warned_at is not null;
create index candidate_session_expires_idx on candidate_session(expires_at);
create index portal_session_expires_idx on portal_session(expires_at);
create index staff_session_expires_idx on staff_session(expires_at);
create index candidate_verification_expires_idx on candidate_verification(expires_at);
create index portal_verification_expires_idx on portal_verification(expires_at);
create index staff_verification_expires_idx on staff_verification(expires_at);
create index candidate_rate_limit_last_idx on candidate_rate_limit(last_request);
create index portal_rate_limit_last_idx on portal_rate_limit(last_request);
create index staff_rate_limit_last_idx on staff_rate_limit(last_request);

-- ===== Settings and switches
create table setting(
  key text primary key, value integer, unit text check (unit in ('days','months','count')),
  is_guess boolean not null default true, solicitor_confirmed_at timestamptz, solicitor_note text,
  updated_by_staff_user_id text references staff_user(id), updated_at timestamptz not null default now());
create index setting_updated_by_idx on setting(updated_by_staff_user_id);
create table feature_flag(
  id bigint generated always as identity primary key, key text not null unique
    check (key in ('on_site_applications','candidate_search','contact_requests','visibility_switch','messaging')),
  enabled boolean not null default false, set_by text, set_at timestamptz, note text);

-- ===== Companies
create table organisation(
  id bigint generated always as identity primary key, slug text not null unique, display_name text not null,
  website text, logo_url text, short_description text, county text, nace_code text, claimed_at timestamptz, verified_at timestamptz,
  kind text not null check (kind in ('employer','agency','public_body')),
  status text not null default 'unclaimed' check (status in ('unclaimed','pending_review','needs_info','verified','verified_restricted','suspended','rejected','banned','closed')),
  signup_path text check (signup_path in ('dete_claim','first_time','agency','admin')),
  cro_number text, wrc_licence_number text, is_big_company boolean not null default false,
  permit_history text not null default 'not_linked' check (permit_history in ('has_history','first_time','not_linked')),
  member_limit integer not null default 10, restricted_until timestamptz, claims_removed_at timestamptz,
  status_changed_at timestamptz, -- set by a trigger whenever status changes (starts the claim_needs_info clock)
  merged_into_id bigint references organisation(id),
  check (wrc_licence_number is null or kind = 'agency'), check (merged_into_id <> id));
create unique index organisation_wrc_unique on organisation(wrc_licence_number) where wrc_licence_number is not null and status not in ('rejected','closed') and merged_into_id is null;
create unique index organisation_cro_unique on organisation(cro_number) where cro_number is not null and status not in ('rejected','closed') and merged_into_id is null;
-- no index on merged_into_id: the parent is never deleted and no stated query filters by it (section 2, indexes)
create table organisation_name(
  id bigint generated always as identity primary key, organisation_id bigint references organisation(id),
  name text not null, normalised_name text not null, kind text not null check (kind in ('legal','alias')),
  source text not null check (source in ('dete','cro','job_site','admin','public_body_list')), cro_number text,
  confirmed_by_staff_id text references staff_user(id), confirmed_at timestamptz);
create unique index organisation_name_alias_unique on organisation_name(normalised_name) where kind = 'alias';
create unique index organisation_name_legal_nocro_unique on organisation_name(normalised_name) where kind = 'legal' and cro_number is null;
create unique index organisation_name_cro_unique on organisation_name(cro_number, normalised_name) where cro_number is not null;
create index organisation_name_org_idx on organisation_name(organisation_id);
create index organisation_name_staff_idx on organisation_name(confirmed_by_staff_id);
create index organisation_name_trgm on organisation_name using gin(normalised_name extensions.gin_trgm_ops);
create table organisation_domain(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id) on delete cascade,
  domain text not null check (domain = lower(domain)), source text not null check (source in ('seed','admin')),
  added_by_staff_id text references staff_user(id), created_at timestamptz not null default now(), unique(organisation_id, domain));
create index organisation_domain_domain_idx on organisation_domain(domain);
create index organisation_domain_staff_idx on organisation_domain(added_by_staff_id);
create table cro_company(
  id bigint generated always as identity primary key, cro_number text not null unique, name text not null, normalised_name text not null,
  status text not null, last_seen_on date not null);
create index cro_company_trgm on cro_company using gin(normalised_name extensions.gin_trgm_ops);
create table dete_permit_count(
  id bigint generated always as identity primary key, dete_name text not null,
  organisation_name_id bigint references organisation_name(id), year smallint not null, month smallint check (month between 1 and 12),
  permits integer not null, source_file text, imported_at timestamptz not null default now(),
  unique nulls not distinct (dete_name, year, month));
create index dete_permit_count_name_idx on dete_permit_count(organisation_name_id);
create table wrc_licence(
  id bigint generated always as identity primary key, licence_number text not null unique, agency_name text, trading_name text, address text, county text,
  first_seen_on date, last_seen_on date);
create table membership(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id),
  portal_user_id text references portal_user(id) on delete set null,
  invited_email text, invited_by_membership_id bigint references membership(id), invite_token_hash text, invite_expires_at timestamptz,
  joined_at timestamptz, removed_at timestamptz,
  role text not null check (role in ('viewer','poster','recruiter','account_owner')), is_signer boolean not null default false,
  status text not null check (status in ('invited','join_requested','awaiting_approval','active','removed')),
  unique(id, organisation_id),
  check (portal_user_id is not null or invited_email is not null or status = 'removed'),
  check (role <> 'viewer' or not is_signer));
create unique index one_owner_per_org on membership(organisation_id) where role = 'account_owner' and status = 'active';
create unique index one_company_per_login on membership(portal_user_id) where status in ('active','awaiting_approval');
create unique index membership_org_user_unique on membership(organisation_id, portal_user_id) where status <> 'removed';
create unique index membership_org_invite_unique on membership(organisation_id, lower(invited_email)) where status = 'invited';
create index membership_org_idx on membership(organisation_id);
create index membership_user_idx on membership(portal_user_id);
create unique index membership_invite_token_unique on membership(invite_token_hash) where invite_token_hash is not null;

-- ===== Two-person rule and consent wording
create table approval_request(
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('threshold','critical_skills_list','ineligible_list','unclear_role_list','public_pay_employer','big_company_entry','pay_floor','strike_2','strike_3','ban','ban_lift','manual_post_sponsor_confirmed','grant_administrator','grant_role','terms_privacy_page')),
  target_table text not null, target_id text not null, change jsonb, effective_from timestamptz, reason text,
  proposed_by_staff_user_id text not null references staff_user(id), confirmed_by_staff_user_id text references staff_user(id),
  status text not null default 'pending' check (status in ('pending','confirmed','refused','withdrawn')), decided_at timestamptz,
  applied_at timestamptz, created_at timestamptz not null default now(),
  check (confirmed_by_staff_user_id <> proposed_by_staff_user_id),
  check (status <> 'confirmed' or confirmed_by_staff_user_id is not null));
create unique index approval_request_pending_unique on approval_request(kind, target_table, target_id) where status = 'pending';
create index approval_request_pending_idx on approval_request(created_at, id) where status = 'pending';
create index approval_request_proposed_idx on approval_request(proposed_by_staff_user_id);
create index approval_request_confirmed_idx on approval_request(confirmed_by_staff_user_id);
create table consent_text(
  id bigint generated always as identity primary key,
  purpose text not null check (purpose in ('signup_terms','privacy_notice','visibility','application','contact_accept','services_request','employer_contact','sponsorship_statement','pay_floor')),
  version text not null, body text not null, published_at timestamptz not null default now(),
  approval_request_id bigint references approval_request(id),
  unique(purpose, version),
  check (approval_request_id is null or purpose in ('signup_terms','privacy_notice')));
create index consent_text_approval_idx on consent_text(approval_request_id);

-- ===== Pay floors
create table pay_floor(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id), role_family text not null,
  floor_eur integer not null check (floor_eur > 0), consent_text_id bigint not null references consent_text(id),
  signer_membership_id bigint not null, signer_name text, signer_title text, signed_at timestamptz not null default now(),
  valid_until timestamptz not null,
  status text not null default 'pending_check' check (status in ('pending_check','active','expired','replaced','withdrawn','rejected','found_false')),
  ended_at timestamptz, checked_by_staff_id text references staff_user(id), checked_at timestamptz,
  approval_request_id bigint references approval_request(id), replaces_id bigint references pay_floor(id),
  foreign key (signer_membership_id, organisation_id) references membership(id, organisation_id),
  check (valid_until > signed_at), check (status <> 'active' or approval_request_id is not null));
create unique index pay_floor_one_active on pay_floor(organisation_id, role_family) where status = 'active';
create unique index pay_floor_one_pending on pay_floor(organisation_id, role_family) where status = 'pending_check';
create index pay_floor_org_idx on pay_floor(organisation_id);
create index pay_floor_signer_idx on pay_floor(signer_membership_id, organisation_id);
create index pay_floor_text_idx on pay_floor(consent_text_id);
create index pay_floor_staff_idx on pay_floor(checked_by_staff_id);
create index pay_floor_approval_idx on pay_floor(approval_request_id);
create index pay_floor_replaces_idx on pay_floor(replaces_id);

-- ===== Jobs
create table job_source(
  id bigint generated always as identity primary key, kind text not null, board text not null,
  last_ok_at timestamptz, last_error text, unique(kind, board));
create table fetched_advert(
  id bigint generated always as identity primary key, job_source_id bigint not null references job_source(id), external_id text not null,
  url text, title text, employer_name text, first_seen_at timestamptz not null default now(), last_seen_at timestamptz not null default now(), gone_at timestamptz,
  result text not null check (result in ('passed','queued','rejected')), stage text, reason text, quoted_evidence text, matcher_model text,
  unique(job_source_id, external_id));
create index fetched_advert_rejected_idx on fetched_advert(last_seen_at) where result = 'rejected';
create table job(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id),
  source text not null check (source in ('fetched','employer','agency','admin_manual')),
  job_source_id bigint not null references job_source(id), fetched_advert_id bigint unique references fetched_advert(id),
  title text not null, employer_name text not null, county text, sector text not null, occupation_code text, contract_type text, contract_months smallint,
  permit_type text not null check (permit_type in ('critical_skills','general')),
  badge text check (badge in ('sponsor_confirmed','critical_skills_eligible')),
  salary_low integer, salary_high integer, salary_sort integer generated always as (coalesce(salary_high, salary_low, 0)) stored,
  health_insurance_eur integer check (health_insurance_eur >= 0), pay_grade text,
  pass_route text check (pass_route in ('stated_pay','big_company','pay_floor','public_pay')), pay_floor_id bigint references pay_floor(id),
  quota_full boolean not null default false,
  status text not null check (status in ('draft','in_review','live','under_review','hidden','closed')),
  close_reason text check (close_reason in ('expired','closed','removed','under_review_expired','abandoned')),
  created_at timestamptz not null default now(), posted_at timestamptz not null default now(), closes_at timestamptz not null, closed_at timestamptz,
  hidden_reason text check (hidden_reason in ('report','organisation_suspended','admin')), hidden_report_id bigint,
  search_vector tsvector,
  permit_history text not null default 'not_linked' check (permit_history in ('has_history','first_time','not_linked')),
  application_route text not null default 'own_page' check (application_route in ('own_page','on_site')), own_page_url text, route_switched_at timestamptz,
  screening_questions jsonb not null default '[]',
  permit_employer_kind text not null default 'self' check (permit_employer_kind in ('self','client')), permit_employer_name text,
  permit_employer_name_id bigint references organisation_name(id),
  permit_employer_check text not null default 'pending' check (permit_employer_check in ('pending','found','not_found')),
  posted_by_membership_id bigint, posted_by_staff_id text references staff_user(id),
  hire_answer text check (hire_answer in ('yes','no')), hire_answered_at timestamptz, hire_answered_by_membership_id bigint references membership(id),
  unique(id, organisation_id),
  foreign key (posted_by_membership_id, organisation_id) references membership(id, organisation_id),
  check (num_nonnulls(posted_by_membership_id, posted_by_staff_id) <= 1),
  check (application_route <> 'own_page' or own_page_url is not null),
  check (status <> 'live' or search_vector is not null),
  check (source <> 'fetched' or (permit_type = 'critical_skills' and badge is distinct from 'sponsor_confirmed' and application_route <> 'on_site')),
  check (source <> 'fetched' or status <> 'live' or badge is not distinct from 'critical_skills_eligible'),
  check (badge is distinct from 'critical_skills_eligible' or permit_type = 'critical_skills'),
  check (source not in ('employer','agency') or status in ('draft','closed') or salary_low is not null or salary_high is not null or pay_grade is not null),
  check ((status = 'hidden') = (hidden_reason is not null)),
  check (hidden_report_id is null or hidden_reason = 'report'),
  check (hidden_reason is distinct from 'report' or hidden_report_id is not null),
  check (application_route = 'own_page'), -- Launch B lock, dropped by the Launch B migration
  check (application_route = 'on_site' or screening_questions = '[]'::jsonb),
  check (jsonb_typeof(screening_questions) = 'array' and jsonb_array_length(screening_questions) <= 5));
create index job_live_newest on job((not quota_full) desc, posted_at desc, id desc) include (quota_full, closes_at) where status = 'live';
create index job_live_salary on job((not quota_full) desc, salary_sort desc, id desc) include (quota_full, closes_at) where status = 'live';
create index job_live_sector_newest on job(sector, (not quota_full) desc, posted_at desc, id desc) include (quota_full, closes_at) where status = 'live';
create index job_live_sector_salary on job(sector, (not quota_full) desc, salary_sort desc, id desc) include (quota_full, closes_at) where status = 'live';
create index job_live_search on job using gin(search_vector) with (fastupdate = off) where status = 'live';
create index job_life_idx on job(closes_at) where status in ('live','under_review') and closes_at < 'infinity';
create index job_organisation_idx on job(organisation_id, posted_at desc, id desc); -- replaces the plain organisation_id index, serves the portal job list
create index job_company_page_idx on job(organisation_id, (not quota_full) desc, posted_at desc, id desc) where status = 'live';
-- Not built (section 2, indexes): job_source_id, posted_by_membership_id, posted_by_staff_id, hire_answered_by_membership_id, permit_employer_name_id.
create index job_pay_floor_idx on job(pay_floor_id);
create index job_hidden_report_idx on job(hidden_report_id);
create index job_closed_idx on job(closed_at) where status = 'closed';
create index job_draft_idx on job(created_at) where status = 'draft';
create table job_text(job_id bigint primary key references job(id) on delete cascade, advert_text text not null);
create table fetch_run(
  id bigint generated always as identity primary key, job_source_id bigint not null references job_source(id),
  started_at timestamptz not null default now(), finished_at timestamptz, seen integer, new integer, closed integer, error text);
create index fetch_run_source_idx on fetch_run(job_source_id);
create index fetch_run_started_idx on fetch_run(started_at);
create table job_daily_stat(
  id bigint generated always as identity primary key, job_id bigint not null references job(id) on delete cascade, day date not null,
  views integer not null default 0, apply_clicks integer not null default 0, unique(job_id, day));

-- ===== Consent proof (shared) and candidate tables
create table consent_record(
  id bigint generated always as identity primary key,
  candidate_user_id text references candidate_user(id) on delete set null, portal_user_id text references portal_user(id) on delete set null,
  consent_text_id bigint not null references consent_text(id), given_at timestamptz not null default now(), withdrawn_at timestamptz,
  job_id bigint references job(id) on delete set null, organisation_id bigint references organisation(id), details jsonb, subject_erased_at timestamptz,
  check (num_nonnulls(candidate_user_id, portal_user_id) = 1 or subject_erased_at is not null));
create index consent_record_candidate_idx on consent_record(candidate_user_id);
create index consent_record_portal_idx on consent_record(portal_user_id);
create index consent_record_job_idx on consent_record(job_id);
create index consent_record_erased_idx on consent_record(subject_erased_at) where subject_erased_at is not null; -- consent_bare_proof
-- Not built: consent_text_id, organisation_id (section 2, indexes).
create table candidate_profile(
  id bigint generated always as identity primary key, candidate_user_id text not null unique references candidate_user(id) on delete cascade,
  full_name text, phone text, occupation_code text, years_experience smallint check (years_experience between 0 and 60),
  has_relevant_degree boolean, degree_field text, degree_awarded_month date,
  registration_body text, registration_number text, registration_status text check (registration_status in ('none','in_progress','registered')),
  location_kind text check (location_kind in ('abroad','ireland')), current_stamp text,
  visible_to_employers boolean not null default false, visible_fields text[],
  check (current_stamp is null or location_kind = 'ireland'),
  check (degree_awarded_month is null or (has_relevant_degree is true and extract(day from degree_awarded_month) = 1)),
  check (visible_to_employers = false)); -- Launch B lock
create table candidate_cv(
  id bigint generated always as identity primary key, candidate_user_id text not null unique references candidate_user(id) on delete cascade,
  storage_key text not null, file_name text not null, content_type text not null check (content_type in ('pdf','docx')),
  size_bytes integer not null check (size_bytes between 1 and 10485760), uploaded_at timestamptz not null default now());
create table saved_job(
  id bigint generated always as identity primary key, candidate_user_id text not null references candidate_user(id) on delete cascade,
  job_id bigint not null references job(id), created_at timestamptz not null default now(), unique(candidate_user_id, job_id));
create index saved_job_job_idx on saved_job(job_id);
create table application(
  id bigint generated always as identity primary key, job_id bigint not null, organisation_id bigint not null,
  candidate_user_id text references candidate_user(id), -- #133: emptied by application_and_cv and erase_candidate, the row stays as a record
  status text not null default 'applied' check (status in ('applied','viewed','shortlisted','rejected','offer','hired','withdrawn')),
  cover_note text, answers jsonb, profile_summary jsonb, cv_storage_key text, cv_file_name text,
  consent_record_id bigint references consent_record(id), withdrawn_at timestamptz, created_at timestamptz not null default now(),
  foreign key (job_id, organisation_id) references job(id, organisation_id), unique(candidate_user_id, job_id),
  -- PICK: "empty" means NULL; the design says the five detail columns are "all empty"
  check (candidate_user_id is not null or (cover_note is null and answers is null and profile_summary is null and cv_storage_key is null and cv_file_name is null)),
  check (consent_record_id is not null or candidate_user_id is null));
create index application_job_idx on application(job_id, organisation_id);
create index application_org_idx on application(organisation_id, created_at desc, id desc);
create index application_consent_idx on application(consent_record_id);
create table tracker_entry(
  id bigint generated always as identity primary key, candidate_user_id text not null references candidate_user(id) on delete cascade,
  job_id bigint not null references job(id), route text not null check (route in ('redirect','on_site')),
  origin text not null check (origin in ('did_you_apply_yes','mark_applied','on_site')), stage text not null,
  application_id bigint references application(id) on delete set null, updated_at timestamptz not null default now(),
  unique(candidate_user_id, job_id),
  check ((route = 'redirect' and stage in ('applied','interview','offer','rejected','withdrawn')) or (route = 'on_site' and stage in ('applied','viewed','shortlisted','rejected','offer','hired','withdrawn'))));
create index tracker_entry_job_idx on tracker_entry(job_id);
create index tracker_entry_application_idx on tracker_entry(application_id);
create table apply_click(
  id bigint generated always as identity primary key, candidate_user_id text not null references candidate_user(id) on delete cascade,
  job_id bigint not null references job(id), clicked_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','not_yet','yes','no','expired')),
  times_asked smallint not null default 0 check (times_asked between 0 and 2), answered_at timestamptz);
create unique index apply_click_open_unique on apply_click(candidate_user_id, job_id) where status in ('pending','not_yet');
create index apply_click_job_idx on apply_click(job_id);
create index apply_click_candidate_idx on apply_click(candidate_user_id);
create index apply_click_clicked_idx on apply_click(clicked_at);
create table alert(
  id bigint generated always as identity primary key, candidate_user_id text not null references candidate_user(id) on delete cascade,
  occupation_code text, sector text, county text, badge text, salary_min integer, search_text text,
  frequency text not null check (frequency in ('daily','weekly')), status text not null default 'active' check (status in ('active','paused','unsubscribed')),
  pause_reason text check (pause_reason in ('dormant','stamp_4','candidate')), unsubscribe_token text not null unique, last_sent_at timestamptz);
create index alert_candidate_idx on alert(candidate_user_id);
create index alert_send_idx on alert(frequency, last_sent_at) where status = 'active';
create table contact_request(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id), membership_id bigint not null,
  candidate_user_id text references candidate_user(id) on delete set null,
  status text not null default 'sent' check (status in ('sent','accepted','declined','withdrawn','expired')),
  released_details jsonb, consent_record_id bigint references consent_record(id), sent_at timestamptz not null default now(), answered_at timestamptz,
  foreign key (membership_id, organisation_id) references membership(id, organisation_id),
  check (status <> 'accepted' or consent_record_id is not null));
create unique index contact_request_open_unique on contact_request(organisation_id, candidate_user_id) where status = 'sent';
create index contact_request_org_day_idx on contact_request(organisation_id, sent_at);
create index contact_request_membership_idx on contact_request(membership_id, organisation_id);
create index contact_request_candidate_idx on contact_request(candidate_user_id);
create index contact_request_consent_idx on contact_request(consent_record_id);
create table candidate_hidden_organisation(
  id bigint generated always as identity primary key, candidate_user_id text not null references candidate_user(id) on delete cascade,
  organisation_id bigint not null references organisation(id), created_at timestamptz not null default now(), unique(candidate_user_id, organisation_id));
create index candidate_hidden_org_idx on candidate_hidden_organisation(organisation_id);
create table message(
  id bigint generated always as identity primary key, application_id bigint references application(id) on delete cascade,
  contact_request_id bigint references contact_request(id) on delete cascade,
  sender_candidate_user_id text references candidate_user(id) on delete cascade, sender_membership_id bigint references membership(id),
  body text not null check (length(body) between 1 and 5000), created_at timestamptz not null default now(), read_at timestamptz,
  check (num_nonnulls(application_id, contact_request_id) = 1), check (num_nonnulls(sender_candidate_user_id, sender_membership_id) = 1));
create index message_application_idx on message(application_id, created_at);
create index message_contact_request_idx on message(contact_request_id, created_at);
create index message_sender_candidate_idx on message(sender_candidate_user_id);
create index message_sender_membership_idx on message(sender_membership_id);

-- ===== Employer statements
create table sponsorship_statement(
  id bigint generated always as identity primary key, job_id bigint not null references job(id), organisation_id bigint not null references organisation(id),
  kind text not null check (kind in ('own_company','on_behalf_of_client','admin_on_behalf')),
  consent_text_id bigint not null references consent_text(id),
  signer_membership_id bigint, signer_name text, signer_title text, signed_at timestamptz not null default now(),
  on_behalf_of_name text, written_authority_on_file boolean not null default false,
  confirmation_file_key text, entered_by_staff_id text references staff_user(id), approval_request_id bigint references approval_request(id), superseded_at timestamptz,
  foreign key (signer_membership_id, organisation_id) references membership(id, organisation_id),
  check (kind <> 'on_behalf_of_client' or (on_behalf_of_name is not null and written_authority_on_file)),
  check ((kind = 'admin_on_behalf' and confirmation_file_key is not null and approval_request_id is not null and signer_membership_id is null) or (kind <> 'admin_on_behalf' and signer_membership_id is not null)));
create unique index one_current_statement on sponsorship_statement(job_id) where superseded_at is null;
create index sponsorship_statement_job_idx on sponsorship_statement(job_id);
create index sponsorship_statement_org_idx on sponsorship_statement(organisation_id);
create index sponsorship_statement_text_idx on sponsorship_statement(consent_text_id);
create index sponsorship_statement_signer_idx on sponsorship_statement(signer_membership_id, organisation_id);
create index sponsorship_statement_staff_idx on sponsorship_statement(entered_by_staff_id);
create index sponsorship_statement_approval_idx on sponsorship_statement(approval_request_id);

-- ===== Staff roles and services
create table staff_role(
  id bigint generated always as identity primary key, staff_user_id text not null references staff_user(id),
  role text not null check (role in ('account_reviewer','fetched_job_reviewer','rules_data_editor','trust_and_safety','services_case_handler','content_editor','administrator')),
  granted_by_staff_user_id text references staff_user(id), approval_request_id bigint references approval_request(id), seeded_by_owner boolean not null default false,
  unique(staff_user_id, role), check (approval_request_id is not null or seeded_by_owner is true));
create index staff_role_granted_by_idx on staff_role(granted_by_staff_user_id);
create index staff_role_approval_idx on staff_role(approval_request_id);
create table services_case(
  id bigint generated always as identity primary key, candidate_user_id text references candidate_user(id) on delete set null, portal_user_id text references portal_user(id) on delete set null,
  requester_erased_at timestamptz, organisation_id bigint references organisation(id), job_id bigint references job(id), permit_type text,
  offer_details jsonb, payer text check (payer in ('employer','agency')),
  status text not null default 'received' check (status in ('received','documents_needed','waiting_for_employer','submitted','decision','closed')),
  decided_at timestamptz, closed_at timestamptz, close_reason text check (close_reason in ('decided','employer_not_engaged','withdrawn','referred_to_solicitor','no_reply')),
  consent_record_id bigint not null references consent_record(id), employer_contact_consent_record_id bigint references consent_record(id),
  assigned_staff_user_id text references staff_user(id), dedupe_key text, created_at timestamptz not null default now(),
  check (num_nonnulls(candidate_user_id, portal_user_id) = 1 or requester_erased_at is not null),
  check (portal_user_id is null or dedupe_key is not null),
  check (status <> 'closed' or (closed_at is not null and close_reason is not null)));
create unique index services_case_candidate_open on services_case(candidate_user_id, job_id) nulls not distinct where status <> 'closed' and candidate_user_id is not null;
create unique index services_case_dedupe_unique on services_case(dedupe_key) where dedupe_key is not null; -- portal requests: ten taps make one case
create index services_case_board_idx on services_case(status, created_at, id) where status <> 'closed';
create index services_case_candidate_idx on services_case(candidate_user_id);
create index services_case_portal_idx on services_case(portal_user_id);
create index services_case_org_idx on services_case(organisation_id);
create index services_case_job_idx on services_case(job_id);
create index services_case_consent_idx on services_case(consent_record_id);
create index services_case_contact_consent_idx on services_case(employer_contact_consent_record_id);
create index services_case_staff_idx on services_case(assigned_staff_user_id);
create table case_note(
  id bigint generated always as identity primary key, services_case_id bigint not null references services_case(id) on delete cascade,
  author_staff_user_id text not null references staff_user(id), body text not null, created_at timestamptz not null default now());
create index case_note_case_idx on case_note(services_case_id);
create index case_note_author_idx on case_note(author_staff_user_id);
create table case_document(
  id bigint generated always as identity primary key, services_case_id bigint not null references services_case(id) on delete cascade,
  storage_key text, file_name text, content_type text, byte_size integer,
  candidate_user_id text references candidate_user(id) on delete set null, portal_user_id text references portal_user(id) on delete set null, staff_user_id text references staff_user(id),
  uploaded_at timestamptz not null default now(), copy_deleted_at timestamptz,
  check (num_nonnulls(candidate_user_id, portal_user_id, staff_user_id) <= 1), check ((storage_key is null) = (copy_deleted_at is not null)));
create index case_document_case_idx on case_document(services_case_id);
create index case_document_candidate_idx on case_document(candidate_user_id);
create index case_document_portal_idx on case_document(portal_user_id);
create index case_document_staff_idx on case_document(staff_user_id);
create table case_quote(
  id bigint generated always as identity primary key, services_case_id bigint not null references services_case(id), organisation_id bigint references organisation(id),
  amount_eur integer not null check (amount_eur > 0), status text not null default 'draft' check (status in ('draft','sent','accepted','declined','invoiced','paid','cancelled')),
  invoice_number text, quoted_by_staff_user_id text references staff_user(id), sent_at timestamptz, invoiced_at timestamptz, paid_at timestamptz);
create unique index case_quote_invoice_unique on case_quote(invoice_number) where invoice_number is not null;
create unique index case_quote_open_unique on case_quote(services_case_id) where status in ('draft','sent');
create index case_quote_case_idx on case_quote(services_case_id);
create index case_quote_org_idx on case_quote(organisation_id);
create index case_quote_staff_idx on case_quote(quoted_by_staff_user_id);

-- ===== Content and contact
create table content_page(
  id bigint generated always as identity primary key, kind text not null check (kind in ('guide','update','help')), slug text not null, title text not null, body text not null,
  source_url text, checked_on date, status text not null default 'draft' check (status in ('draft','published','withdrawn')), published_at timestamptz,
  updated_by_staff_user_id text references staff_user(id), updated_at timestamptz not null default now(),
  unique(kind, slug),
  check (status <> 'published' or kind = 'help' or (source_url is not null and checked_on is not null)),
  check (status <> 'published' or published_at is not null));
create index content_page_feed_idx on content_page(kind, published_at desc, id desc) where status = 'published';
create index content_page_stale_idx on content_page(checked_on) where kind = 'guide' and status = 'published';
create index content_page_staff_idx on content_page(updated_by_staff_user_id);
create table contact_message(
  id bigint generated always as identity primary key, surface text not null check (surface in ('candidate_site','portal')),
  candidate_user_id text references candidate_user(id) on delete set null, portal_user_id text references portal_user(id) on delete set null,
  from_name text, from_email text, topic text not null check (topic in ('general','account','data_request','other')),
  body text,
  status text not null default 'new' check (status in ('new','claimed','answered','closed','spam')),
  claimed_by_staff_user_id text references staff_user(id), claimed_at timestamptz, closed_at timestamptz, created_at timestamptz not null default now(),
  check (num_nonnulls(candidate_user_id, portal_user_id) <= 1), check (status <> 'closed' or closed_at is not null),
  check ((body is not null and char_length(body) between 1 and 5000) or (body is null and from_name is null and from_email is null and candidate_user_id is null and portal_user_id is null)));
create index contact_message_inbox_idx on contact_message(status, created_at, id) where status in ('new','claimed');
create index contact_message_candidate_idx on contact_message(candidate_user_id);
create index contact_message_portal_idx on contact_message(portal_user_id);
create index contact_message_staff_idx on contact_message(claimed_by_staff_user_id);

-- ===== Trust and safety
create table report(
  id bigint generated always as identity primary key, target_kind text not null check (target_kind in ('job','organisation','message','profile')), target_wiped_at timestamptz,
  target_job_id bigint references job(id), target_organisation_id bigint references organisation(id),
  target_message_id bigint references message(id) on delete set null, target_candidate_user_id text references candidate_user(id) on delete set null,
  reporter_candidate_user_id text references candidate_user(id) on delete set null, reporter_portal_user_id text references portal_user(id) on delete set null, reporter_wiped_at timestamptz,
  reason text not null check (reason in ('asks_for_money','no_sponsorship','job_closed','wrong_details','other')), evidence_text text, evidence_storage_key text, target_snapshot jsonb,
  status text not null default 'open' check (status in ('open','job_hidden','cleared','upheld')), decided_by_staff_user_id text references staff_user(id), decided_at timestamptz,
  created_at timestamptz not null default now(),
  check (target_wiped_at is not null or num_nonnulls(target_job_id, target_organisation_id, target_message_id, target_candidate_user_id) = 1),
  check (case target_kind when 'job' then num_nonnulls(target_organisation_id, target_message_id, target_candidate_user_id) = 0
                           when 'organisation' then num_nonnulls(target_job_id, target_message_id, target_candidate_user_id) = 0
                           when 'message' then num_nonnulls(target_job_id, target_organisation_id, target_candidate_user_id) = 0
                           else num_nonnulls(target_job_id, target_organisation_id, target_message_id) = 0 end),
  check (num_nonnulls(reporter_candidate_user_id, reporter_portal_user_id) <= 1),
  check (status not in ('cleared','upheld') or num_nonnulls(reporter_candidate_user_id, reporter_portal_user_id) = 0));
create unique index report_candidate_open_unique on report(reporter_candidate_user_id, target_job_id) where status in ('open','job_hidden');
create unique index report_portal_open_unique on report(reporter_portal_user_id, target_job_id) where status in ('open','job_hidden');
create index report_inbox_idx on report(status, created_at, id) where status in ('open','job_hidden');
create index report_target_job_idx on report(target_job_id);
create index report_target_org_idx on report(target_organisation_id);
create index report_target_message_idx on report(target_message_id);
create index report_target_candidate_idx on report(target_candidate_user_id);
create index report_reporter_candidate_idx on report(reporter_candidate_user_id);
create index report_reporter_portal_idx on report(reporter_portal_user_id);
create index report_decided_idx on report(decided_by_staff_user_id);
alter table job add constraint job_hidden_report_fkey foreign key (hidden_report_id) references report(id) on delete set null;
create table strike(
  id bigint generated always as identity primary key, organisation_id bigint not null references organisation(id), created_at timestamptz not null default now(),
  case_kind text not null check (case_kind in ('false_claim','false_pay_floor','instant_ban')),
  job_id bigint references job(id), pay_floor_id bigint references pay_floor(id), report_id bigint references report(id),
  reason_code text not null check (reason_code in ('false_sponsorship','false_pay_floor','asks_for_money','fake_company','fake_job')),
  notice_summary text, level smallint check (level between 1 and 3),
  stage text not null default 'case_open' check (stage in ('case_open','employer_notified','reply_window','decided','applied','appealed','upheld','overturned')),
  outcome text check (outcome in ('cleared','strike','ban')),
  reply_due_at timestamptz, employer_reply text, replied_at timestamptz, reply_received_at timestamptz, reply_entered_by_staff_user_id text references staff_user(id),
  decided_by_staff_user_id text references staff_user(id), decided_at timestamptz,
  approval_request_id bigint references approval_request(id),
  appeal_due_at timestamptz, appeal_text text, appealed_at timestamptz, appeal_received_at timestamptz, appeal_entered_by_staff_user_id text references staff_user(id),
  appeal_decided_by_staff_user_id text references staff_user(id), appeal_decided_at timestamptz,
  ban_lifted_at timestamptz, -- set only by the ban delete trigger
  check (case_kind <> 'instant_ban' or level is null),
  check (outcome is distinct from 'strike' or level is not null),
  check (not ((outcome = 'strike' and level in (2,3)) or outcome = 'ban') or approval_request_id is not null),
  check (appeal_decided_by_staff_user_id <> decided_by_staff_user_id),
  check (stage not in ('upheld','overturned') or (appealed_at is not null and appeal_decided_at is not null and appeal_decided_by_staff_user_id is not null)),
  check (appeal_decided_by_staff_user_id <> appeal_entered_by_staff_user_id),
  check (decided_by_staff_user_id <> reply_entered_by_staff_user_id));
create unique index strike_report_org_unique on strike(report_id, organisation_id) where report_id is not null;
create index strike_clock_idx on strike(stage, reply_due_at) where stage not in ('upheld','overturned') and outcome is distinct from 'cleared';
create index strike_org_idx on strike(organisation_id);
create index strike_job_idx on strike(job_id);
create index strike_pay_floor_idx on strike(pay_floor_id);
create index strike_report_idx on strike(report_id);
create index strike_decided_idx on strike(decided_by_staff_user_id);
create index strike_appeal_idx on strike(appeal_decided_by_staff_user_id);
create index strike_reply_entered_idx on strike(reply_entered_by_staff_user_id);
create index strike_appeal_entered_idx on strike(appeal_entered_by_staff_user_id);
create index strike_approval_idx on strike(approval_request_id);
create table ban(
  id bigint generated always as identity primary key, cro_number text, email_domain text,
  reason_code text not null check (reason_code in ('asks_for_money','fake_company','fake_job','strike_3')),
  strike_id bigint not null references strike(id), approval_request_id bigint not null references approval_request(id),
  check (num_nonnulls(cro_number, email_domain) >= 1));
create unique index ban_cro_unique on ban(cro_number) where cro_number is not null;
create unique index ban_domain_unique on ban(email_domain) where email_domain is not null;
create index ban_strike_idx on ban(strike_id);
create index ban_approval_idx on ban(approval_request_id);
create table review_item(
  id bigint generated always as identity primary key,
  queue text not null check (queue in ('fetched_job','account_review','merge_confirmation','pay_floor_check','post_strike_job_review','scam_flag','agency_client_check','data_request','scheduled_check')),
  job_id bigint references job(id) on delete set null, organisation_id bigint references organisation(id), organisation_name_id bigint references organisation_name(id),
  pay_floor_id bigint references pay_floor(id), candidate_user_id text references candidate_user(id) on delete set null,
  portal_user_id text references portal_user(id) on delete set null, contact_message_id bigint references contact_message(id) on delete set null,
  reason text, detail jsonb, claimed_by_staff_user_id text references staff_user(id), claimed_at timestamptz,
  status text not null default 'open' check (status in ('open','claimed','done','dropped')), decided_by_staff_user_id text references staff_user(id), decided_at timestamptz,
  outcome text, created_at timestamptz not null default now(),
  check (status in ('done','dropped') or (case when queue = 'scheduled_check' then 0 else 1 end) = num_nonnulls(job_id, organisation_id, organisation_name_id, pay_floor_id, candidate_user_id, portal_user_id, contact_message_id)),
  check (queue <> 'data_request' or status not in ('done','dropped') or num_nonnulls(candidate_user_id, portal_user_id) = 0));
create unique index review_item_job_unique on review_item(queue, job_id) where status in ('open','claimed');
create unique index review_item_org_unique on review_item(queue, organisation_id) where status in ('open','claimed');
create unique index review_item_name_unique on review_item(queue, organisation_name_id) where status in ('open','claimed');
create unique index review_item_floor_unique on review_item(queue, pay_floor_id) where status in ('open','claimed');
create unique index review_item_candidate_unique on review_item(queue, candidate_user_id) where status in ('open','claimed');
create unique index review_item_portal_unique on review_item(queue, portal_user_id) where status in ('open','claimed');
create unique index review_item_contact_unique on review_item(queue, contact_message_id) where status in ('open','claimed');
create index review_item_queue_idx on review_item(queue, created_at, id) where status in ('open','claimed');
create index review_item_job_idx on review_item(job_id);
create index review_item_org_idx on review_item(organisation_id);
create index review_item_name_idx on review_item(organisation_name_id);
create index review_item_floor_idx on review_item(pay_floor_id);
create index review_item_candidate_idx on review_item(candidate_user_id);
create index review_item_portal_idx on review_item(portal_user_id);
create index review_item_contact_idx on review_item(contact_message_id);
create index review_item_claimed_idx on review_item(claimed_by_staff_user_id);
create index review_item_decided_idx on review_item(decided_by_staff_user_id);
create index review_item_done_idx on review_item((coalesce(decided_at, created_at))) where status in ('done','dropped');
create table audit_event(
  id bigint generated always as identity primary key, at timestamptz not null default now(), kind text not null check (kind in ('admin_action','data_access','security')),
  actor_staff_user_id text, actor_candidate_user_id text, actor_portal_user_id text, actor_system text, role_in_force text, action text not null,
  object_type text, object_id text, subject_candidate_user_id text, changed_columns text[], before jsonb, after jsonb,
  reason_code text, reason_text text, second_staff_user_id text, related_case text, source text check (source in ('panel','scheduled_job','site')),
  check (num_nonnulls(actor_staff_user_id, actor_candidate_user_id, actor_portal_user_id, actor_system) <= 1));
create index audit_event_at_idx on audit_event(at, id);
create index audit_event_actor_staff_idx on audit_event(actor_staff_user_id) where actor_staff_user_id is not null;
create index audit_event_actor_candidate_idx on audit_event(actor_candidate_user_id) where actor_candidate_user_id is not null;
create index audit_event_actor_portal_idx on audit_event(actor_portal_user_id) where actor_portal_user_id is not null;
-- no index on actor_system: no stated query filters by it
create index audit_event_subject_idx on audit_event(subject_candidate_user_id) where subject_candidate_user_id is not null;
create index audit_event_object_idx on audit_event(object_id, object_type) where object_id is not null; -- id first: audit_pseudonymise filters by the person's id alone

-- ===== Messages to people
create table notification_preference(
  id bigint generated always as identity primary key, candidate_user_id text references candidate_user(id) on delete cascade,
  portal_user_id text references portal_user(id) on delete cascade, staff_user_id text references staff_user(id),
  category text not null, channel text not null check (channel in ('email','in_app')), enabled boolean not null,
  check (num_nonnulls(candidate_user_id, portal_user_id, staff_user_id) = 1));
create unique index notification_pref_candidate on notification_preference(candidate_user_id, category, channel) where candidate_user_id is not null;
create unique index notification_pref_portal on notification_preference(portal_user_id, category, channel) where portal_user_id is not null;
create unique index notification_pref_staff on notification_preference(staff_user_id, category, channel) where staff_user_id is not null;
create table notification(
  id bigint generated always as identity primary key, candidate_user_id text references candidate_user(id) on delete cascade,
  portal_user_id text references portal_user(id) on delete cascade, organisation_id bigint references organisation(id),
  category text not null, template_key text not null, params jsonb, dedupe_key text unique, read_at timestamptz, created_at timestamptz not null default now(),
  check (num_nonnulls(candidate_user_id, portal_user_id) = 1));
create index notification_candidate_idx on notification(candidate_user_id, created_at desc, id desc) where candidate_user_id is not null;
create index notification_portal_idx on notification(portal_user_id, created_at desc, id desc) where portal_user_id is not null;
create index notification_read_idx on notification(read_at) where read_at is not null;
create index notification_unread_idx on notification(created_at) where read_at is null;
-- Not built: notification.organisation_id.
create table email_outbox(
  id bigint generated always as identity primary key, template text not null,
  candidate_user_id text, portal_user_id text, staff_user_id text, membership_id bigint, contact_message_id bigint,
  params jsonb, dedupe_key text unique,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','dropped')), attempts integer not null default 0,
  send_after timestamptz not null default now(), sent_at timestamptz,
  check (num_nonnulls(candidate_user_id, portal_user_id, staff_user_id, membership_id, contact_message_id) = 1));
create index email_outbox_pending_idx on email_outbox(send_after) where status = 'pending';
create index email_outbox_candidate_idx on email_outbox(candidate_user_id) where candidate_user_id is not null; -- erasure delete and stand-in update
create index email_outbox_portal_idx on email_outbox(portal_user_id) where portal_user_id is not null;
create index email_outbox_body_idx on email_outbox((coalesce(sent_at, send_after))) where status in ('sending','sent','failed','dropped') and params is not null; -- email_outbox_sent
create index email_outbox_record_idx on email_outbox((coalesce(sent_at, send_after))) where status in ('sending','sent','failed','dropped'); -- email_outbox_record

-- ===== Table settings (section 7, review 20)
alter table job set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 500, autovacuum_analyze_scale_factor = 0.05);
alter table email_outbox set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table notification set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table candidate_session set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table portal_session set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table staff_session set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table candidate_rate_limit set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table portal_rate_limit set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);
alter table staff_rate_limit set (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 1000, autovacuum_analyze_scale_factor = 0.05);

-- ===== Starting values (section 7)
insert into setting(key, value, unit, is_guess) values
 ('application_and_cv',12,'months',false),('application_record',36,'months',false),('inactive_profile',12,'months',true),
 ('inactive_profile_warning',30,'days',true),('inactive_account',24,'months',false),('unverified_account',7,'days',true),
 ('deleted_account_grace',30,'days',true),('apply_click',14,'days',true),('contact_request_record',12,'months',true),
 ('contact_request_expiry',14,'days',true),('contact_request_reask',90,'days',true),('contact_requests_per_day',20,'count',true),
 ('claim_needs_info',30,'days',true),('portal_removed_member',12,'months',false),('draft_job',12,'months',true),
 ('portal_signer_name',12,'months',true),('services_case_copy',30,'days',true),
 ('services_case_record',72,'months',false),('case_invoice_record',72,'months',false),('strike_and_report_evidence',12,'months',false),
 ('ban_evidence',12,'months',false),('consent_bare_proof',72,'months',false),('contact_message',24,'months',false),
 ('review_item_done',24,'months',false),('notification_read',12,'months',false),('notification_unread',12,'months',false),
 ('email_outbox_sent',30,'days',false),('email_outbox_record',24,'months',false),('rejected_advert',24,'months',false),
 ('closed_job_unreferenced',36,'months',false),('fetch_run',12,'months',false),('staff_entry_grace',7,'days',false),
 ('expired_login_rows',1,'days',true);
-- alert_digest_max_jobs is gone: the 20 is a constant in the send job's code (section 7, Build 10).
insert into feature_flag(key) values ('on_site_applications'),('candidate_search'),('contact_requests'),('visibility_switch'),('messaging');

reset role;
