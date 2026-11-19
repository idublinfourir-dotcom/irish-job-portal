// Made by npm run db:pull (packages/db/test/pull-schema.mjs) from a database built by packages/db/migrations.
// Do not edit by hand: change a migration, then run npm run db:pull. schema.test.ts fails until the two match.
import { customType, pgTable, index, foreignKey, unique, check, bigint, text, jsonb, timestamp, uniqueIndex, type AnyPgColumn, smallint, integer, boolean, date, pgView } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// drizzle-kit cannot read tsvector, so it is declared here
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });



export const application = pgTable("application", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "application_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	candidateUserId: text("candidate_user_id"),
	status: text().default('applied').notNull(),
	coverNote: text("cover_note"),
	answers: jsonb(),
	profileSummary: jsonb("profile_summary"),
	cvStorageKey: text("cv_storage_key"),
	cvFileName: text("cv_file_name"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentRecordId: bigint("consent_record_id", { mode: "number" }),
	withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("application_consent_idx").using("btree", table.consentRecordId.asc().nullsLast().op("int8_ops")),
	index("application_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")),
	index("application_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("int8_ops"), table.id.desc().nullsFirst().op("int8_ops")),
	foreignKey({
			columns: [table.jobId, table.organisationId],
			foreignColumns: [job.id, job.organisationId],
			name: "application_job_id_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "application_candidate_user_id_fkey"
		}),
	foreignKey({
			columns: [table.consentRecordId],
			foreignColumns: [consentRecord.id],
			name: "application_consent_record_id_fkey"
		}),
	unique("application_candidate_user_id_job_id_key").on(table.jobId, table.candidateUserId),
	check("application_status_check", sql`status = ANY (ARRAY['applied'::text, 'viewed'::text, 'shortlisted'::text, 'rejected'::text, 'offer'::text, 'hired'::text, 'withdrawn'::text])`),
	check("application_check", sql`(candidate_user_id IS NOT NULL) OR ((cover_note IS NULL) AND (answers IS NULL) AND (profile_summary IS NULL) AND (cv_storage_key IS NULL) AND (cv_file_name IS NULL))`),
	check("application_check1", sql`(consent_record_id IS NOT NULL) OR (candidate_user_id IS NULL)`),
]);

export const contactRequest = pgTable("contact_request", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "contact_request_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	membershipId: bigint("membership_id", { mode: "number" }).notNull(),
	candidateUserId: text("candidate_user_id"),
	status: text().default('sent').notNull(),
	releasedDetails: jsonb("released_details"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentRecordId: bigint("consent_record_id", { mode: "number" }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	answeredAt: timestamp("answered_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("contact_request_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("contact_request_consent_idx").using("btree", table.consentRecordId.asc().nullsLast().op("int8_ops")),
	index("contact_request_membership_idx").using("btree", table.membershipId.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("contact_request_open_unique").using("btree", table.organisationId.asc().nullsLast().op("int8_ops"), table.candidateUserId.asc().nullsLast().op("text_ops")).where(sql`(status = 'sent'::text)`),
	index("contact_request_org_day_idx").using("btree", table.organisationId.asc().nullsLast().op("timestamptz_ops"), table.sentAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "contact_request_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "contact_request_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.consentRecordId],
			foreignColumns: [consentRecord.id],
			name: "contact_request_consent_record_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId, table.membershipId],
			foreignColumns: [membership.id, membership.organisationId],
			name: "contact_request_membership_id_organisation_id_fkey"
		}),
	check("contact_request_status_check", sql`status = ANY (ARRAY['sent'::text, 'accepted'::text, 'declined'::text, 'withdrawn'::text, 'expired'::text])`),
	check("contact_request_check", sql`(status <> 'accepted'::text) OR (consent_record_id IS NOT NULL)`),
]);

export const candidateHiddenOrganisation = pgTable("candidate_hidden_organisation", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "candidate_hidden_organisation_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("candidate_hidden_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "candidate_hidden_organisation_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "candidate_hidden_organisation_organisation_id_fkey"
		}),
	unique("candidate_hidden_organisation_candidate_user_id_organisatio_key").on(table.candidateUserId, table.organisationId),
]);

export const message = pgTable("message", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "message_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	applicationId: bigint("application_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	contactRequestId: bigint("contact_request_id", { mode: "number" }),
	senderCandidateUserId: text("sender_candidate_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	senderMembershipId: bigint("sender_membership_id", { mode: "number" }),
	body: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("message_application_idx").using("btree", table.applicationId.asc().nullsLast().op("int8_ops"), table.createdAt.asc().nullsLast().op("int8_ops")),
	index("message_contact_request_idx").using("btree", table.contactRequestId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("int8_ops")),
	index("message_sender_candidate_idx").using("btree", table.senderCandidateUserId.asc().nullsLast().op("text_ops")),
	index("message_sender_membership_idx").using("btree", table.senderMembershipId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [application.id],
			name: "message_application_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactRequestId],
			foreignColumns: [contactRequest.id],
			name: "message_contact_request_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderCandidateUserId],
			foreignColumns: [candidateUser.id],
			name: "message_sender_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.senderMembershipId],
			foreignColumns: [membership.id],
			name: "message_sender_membership_id_fkey"
		}),
	check("message_body_check", sql`(length(body) >= 1) AND (length(body) <= 5000)`),
	check("message_check", sql`num_nonnulls(application_id, contact_request_id) = 1`),
	check("message_check1", sql`num_nonnulls(sender_candidate_user_id, sender_membership_id) = 1`),
]);

export const job = pgTable("job", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "job_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	source: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobSourceId: bigint("job_source_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	fetchedAdvertId: bigint("fetched_advert_id", { mode: "number" }),
	title: text().notNull(),
	employerName: text("employer_name").notNull(),
	county: text(),
	sector: text().notNull(),
	occupationCode: text("occupation_code"),
	contractType: text("contract_type"),
	contractMonths: smallint("contract_months"),
	permitType: text("permit_type").notNull(),
	badge: text(),
	salaryLow: integer("salary_low"),
	salaryHigh: integer("salary_high"),
	salarySort: integer("salary_sort").generatedAlwaysAs(sql`COALESCE(salary_high, salary_low, 0)`),
	healthInsuranceEur: integer("health_insurance_eur"),
	payGrade: text("pay_grade"),
	passRoute: text("pass_route"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	payFloorId: bigint("pay_floor_id", { mode: "number" }),
	quotaFull: boolean("quota_full").default(false).notNull(),
	status: text().notNull(),
	closeReason: text("close_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	postedAt: timestamp("posted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closesAt: timestamp("closes_at", { withTimezone: true, mode: 'string' }).notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	hiddenReason: text("hidden_reason"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	// job and report point at each other; a typed lazy reference here (instead of the pulled foreignKey) breaks the type cycle
	hiddenReportId: bigint("hidden_report_id", { mode: "number" }).references((): AnyPgColumn => report.id, { onDelete: "set null" }),
	searchVector: tsvector("search_vector"),
	permitHistory: text("permit_history").default('not_linked').notNull(),
	applicationRoute: text("application_route").default('own_page').notNull(),
	ownPageUrl: text("own_page_url"),
	routeSwitchedAt: timestamp("route_switched_at", { withTimezone: true, mode: 'string' }),
	screeningQuestions: jsonb("screening_questions").default([]).notNull(),
	permitEmployerKind: text("permit_employer_kind").default('self').notNull(),
	permitEmployerName: text("permit_employer_name"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	permitEmployerNameId: bigint("permit_employer_name_id", { mode: "number" }),
	permitEmployerCheck: text("permit_employer_check").default('pending').notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	postedByMembershipId: bigint("posted_by_membership_id", { mode: "number" }),
	postedByStaffId: text("posted_by_staff_id"),
	hireAnswer: text("hire_answer"),
	hireAnsweredAt: timestamp("hire_answered_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	hireAnsweredByMembershipId: bigint("hire_answered_by_membership_id", { mode: "number" }),
	sponsorSort: integer("sponsor_sort").default(sql`'-1'`).notNull(),
	weeklyHours: smallint("weekly_hours"),
	underReviewSince: timestamp("under_review_since", { withTimezone: true, mode: 'string' }),
	exceptionConfirmedAt: timestamp("exception_confirmed_at", { withTimezone: true, mode: 'string' }),
	underReviewReason: text("under_review_reason"),
}, (table) => [
	index("job_closed_idx").using("btree", table.closedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'closed'::text)`),
	index("job_company_page_idx").using("btree", sql`organisation_id`, sql`((NOT quota_full))`, sql`posted_at`, sql`id`).where(sql`(status = 'live'::text)`),
	index("job_draft_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'draft'::text)`),
	index("job_hidden_report_idx").using("btree", table.hiddenReportId.asc().nullsLast().op("int8_ops")),
	index("job_manual_idx").using("btree", table.id.desc().nullsFirst().op("int8_ops")).where(sql`(source = 'admin_manual'::text)`),
	index("job_life_idx").using("btree", table.closesAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = ANY (ARRAY['live'::text, 'under_review'::text])) AND (closes_at < 'infinity'::timestamp with time zone))`),
	index("job_live_newest").using("btree", sql`((NOT quota_full))`, sql`posted_at`, sql`id`, sql`quota_full`, sql`closes_at`, sql`salary_low`, sql`salary_high`).where(sql`(status = 'live'::text)`),
	index("job_live_sponsor").using("btree", sql`((NOT quota_full))`, sql`sponsor_sort`, sql`posted_at`, sql`id`, sql`quota_full`, sql`closes_at`, sql`salary_low`, sql`salary_high`).where(sql`(status = 'live'::text)`),
	index("job_live_salary").using("btree", sql`((NOT quota_full))`, sql`salary_sort`, sql`id`, sql`quota_full`, sql`closes_at`).where(sql`(status = 'live'::text)`),
	index("job_live_search").using("gin", table.searchVector.asc().nullsLast().op("tsvector_ops")).where(sql`(status = 'live'::text)`).with({fastupdate: "off"}),
	index("job_live_sector_newest").using("btree", sql`sector`, sql`((NOT quota_full))`, sql`posted_at`, sql`id`, sql`quota_full`, sql`closes_at`).where(sql`(status = 'live'::text)`),
	index("job_live_sector_sponsor").using("btree", sql`sector`, sql`((NOT quota_full))`, sql`sponsor_sort`, sql`posted_at`, sql`id`, sql`quota_full`, sql`closes_at`).where(sql`(status = 'live'::text)`),
	index("job_live_sector_salary").using("btree", sql`sector`, sql`((NOT quota_full))`, sql`salary_sort`, sql`id`, sql`quota_full`, sql`closes_at`).where(sql`(status = 'live'::text)`),
	index("job_organisation_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops"), table.postedAt.desc().nullsFirst().op("int8_ops"), table.id.desc().nullsFirst().op("int8_ops")),
	index("job_pay_floor_idx").using("btree", table.payFloorId.asc().nullsLast().op("int8_ops")),
	index("job_under_review_idx").using("btree", table.underReviewSince.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'under_review'::text)`),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "job_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.jobSourceId],
			foreignColumns: [jobSource.id],
			name: "job_job_source_id_fkey"
		}),
	foreignKey({
			columns: [table.fetchedAdvertId],
			foreignColumns: [fetchedAdvert.id],
			name: "job_fetched_advert_id_fkey"
		}),
	foreignKey({
			columns: [table.payFloorId],
			foreignColumns: [payFloor.id],
			name: "job_pay_floor_id_fkey"
		}),
	foreignKey({
			columns: [table.permitEmployerNameId],
			foreignColumns: [organisationName.id],
			name: "job_permit_employer_name_id_fkey"
		}),
	foreignKey({
			columns: [table.postedByStaffId],
			foreignColumns: [staffUser.id],
			name: "job_posted_by_staff_id_fkey"
		}),
	foreignKey({
			columns: [table.hireAnsweredByMembershipId],
			foreignColumns: [membership.id],
			name: "job_hire_answered_by_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId, table.postedByMembershipId],
			foreignColumns: [membership.id, membership.organisationId],
			name: "job_posted_by_membership_id_organisation_id_fkey"
		}),
	unique("job_id_organisation_id_key").on(table.id, table.organisationId),
	unique("job_fetched_advert_id_key").on(table.fetchedAdvertId),
	check("job_source_check", sql`source = ANY (ARRAY['fetched'::text, 'employer'::text, 'agency'::text, 'admin_manual'::text])`),
	check("job_permit_type_check", sql`permit_type = ANY (ARRAY['critical_skills'::text, 'general'::text])`),
	check("job_badge_check", sql`badge = ANY (ARRAY['sponsor_confirmed'::text, 'critical_skills_eligible'::text])`),
	check("job_health_insurance_eur_check", sql`health_insurance_eur >= 0`),
	check("job_pass_route_check", sql`pass_route = ANY (ARRAY['stated_pay'::text, 'big_company'::text, 'pay_floor'::text, 'public_pay'::text])`),
	check("job_hire_answer_check", sql`hire_answer = ANY (ARRAY['yes'::text, 'no'::text])`),
	check("job_status_check", sql`status = ANY (ARRAY['draft'::text, 'in_review'::text, 'live'::text, 'under_review'::text, 'hidden'::text, 'closed'::text])`),
	check("job_close_reason_check", sql`close_reason = ANY (ARRAY['expired'::text, 'closed'::text, 'removed'::text, 'under_review_expired'::text, 'abandoned'::text, 'recheck_failed'::text, 'source_stale'::text])`),
	check("job_hidden_reason_check", sql`hidden_reason = ANY (ARRAY['report'::text, 'organisation_suspended'::text, 'admin'::text])`),
	check("job_under_review_reason_check", sql`under_review_reason = ANY (ARRAY['pay_check'::text, 'GENERAL_RULES_NOT_SET'::text, 'OCCUPATION_INELIGIBLE'::text, 'QUOTA_FULL'::text, 'OCCUPATION_NOT_ON_LIST'::text, 'CONTRACT_TOO_SHORT'::text, 'RULES_FAILED'::text, 'PAY_REQUIRED'::text, 'PAY_BELOW_MINIMUM'::text, 'STATEMENT_REQUIRED'::text, 'NEEDS_REVIEW'::text])`),
	check("job_under_review_reason_check2", sql`(status = 'under_review'::text) = (under_review_reason IS NOT NULL)`),
	check("job_permit_history_check", sql`permit_history = ANY (ARRAY['has_history'::text, 'first_time'::text, 'not_linked'::text])`),
	check("job_application_route_check", sql`application_route = ANY (ARRAY['own_page'::text, 'on_site'::text])`),
	check("job_permit_employer_kind_check", sql`permit_employer_kind = ANY (ARRAY['self'::text, 'client'::text])`),
	check("job_permit_employer_check_check", sql`permit_employer_check = ANY (ARRAY['pending'::text, 'found'::text, 'not_found'::text])`),
	check("job_check", sql`num_nonnulls(posted_by_membership_id, posted_by_staff_id) <= 1`),
	check("job_check1", sql`(application_route <> 'own_page'::text) OR (own_page_url IS NOT NULL)`),
	check("job_check2", sql`(status <> 'live'::text) OR (search_vector IS NOT NULL)`),
	check("job_check3", sql`(source <> 'fetched'::text) OR ((permit_type = 'critical_skills'::text) AND (badge IS DISTINCT FROM 'sponsor_confirmed'::text) AND (application_route <> 'on_site'::text))`),
	check("job_check4", sql`(source <> 'fetched'::text) OR (status <> 'live'::text) OR (NOT (badge IS DISTINCT FROM 'critical_skills_eligible'::text))`),
	check("job_check5", sql`(badge IS DISTINCT FROM 'critical_skills_eligible'::text) OR (permit_type = 'critical_skills'::text)`),
	check("job_check6", sql`(source <> ALL (ARRAY['employer'::text, 'agency'::text])) OR (status = ANY (ARRAY['draft'::text, 'closed'::text])) OR (salary_low IS NOT NULL) OR (salary_high IS NOT NULL) OR (pay_grade IS NOT NULL)`),
	check("job_check7", sql`(status = 'hidden'::text) = (hidden_reason IS NOT NULL)`),
	check("job_check8", sql`(hidden_report_id IS NULL) OR (hidden_reason = 'report'::text)`),
	check("job_check9", sql`(hidden_reason IS DISTINCT FROM 'report'::text) OR (hidden_report_id IS NOT NULL)`),
	check("job_application_route_check1", sql`application_route = 'own_page'::text`),
	check("job_check10", sql`(application_route = 'on_site'::text) OR (screening_questions = '[]'::jsonb)`),
	check("job_screening_questions_check", sql`(jsonb_typeof(screening_questions) = 'array'::text) AND (jsonb_array_length(screening_questions) <= 5)`),
	check("job_sponsor_sort_check", sql`sponsor_sort >= '-1'::integer`),
	check("job_recheck_failed_fetched", sql`(close_reason IS DISTINCT FROM 'recheck_failed'::text) OR (source = 'fetched'::text)`),
	check("job_source_stale_fetched", sql`(close_reason IS DISTINCT FROM 'source_stale'::text) OR (source = 'fetched'::text)`),
	check("job_weekly_hours_check", sql`(weekly_hours >= 1) AND (weekly_hours <= 60)`),
]);

export const jobText = pgTable("job_text", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).primaryKey().notNull(),
	advertText: text("advert_text").notNull(),
}, (table) => [
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "job_text_job_id_fkey"
		}).onDelete("cascade"),
]);

export const jobSource = pgTable("job_source", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "job_source_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	kind: text().notNull(),
	board: text().notNull(),
	lastOkAt: timestamp("last_ok_at", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
}, (table) => [
	unique("job_source_kind_board_key").on(table.kind, table.board),
]);

export const fetchedAdvert = pgTable("fetched_advert", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "fetched_advert_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobSourceId: bigint("job_source_id", { mode: "number" }).notNull(),
	externalId: text("external_id").notNull(),
	url: text(),
	title: text(),
	employerName: text("employer_name"),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	goneAt: timestamp("gone_at", { withTimezone: true, mode: 'string' }),
	result: text().notNull(),
	stage: text(),
	reason: text(),
	quotedEvidence: text("quoted_evidence"),
	matcherModel: text("matcher_model"),
	contentHash: text("content_hash"),
	wrcAgency: boolean("wrc_agency").default(false).notNull(),
}, (table) => [
	index("fetched_advert_rejected_idx").using("btree", table.lastSeenAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(result = 'rejected'::text)`),
	foreignKey({
			columns: [table.jobSourceId],
			foreignColumns: [jobSource.id],
			name: "fetched_advert_job_source_id_fkey"
		}),
	unique("fetched_advert_job_source_id_external_id_key").on(table.jobSourceId, table.externalId),
	check("fetched_advert_content_hash_check", sql`(content_hash IS NULL) OR (content_hash ~ '^[0-9a-f]{64}$'::text)`),
	check("fetched_advert_result_check", sql`result = ANY (ARRAY['passed'::text, 'queued'::text, 'rejected'::text])`),
	check("fetched_advert_short_text", sql`(COALESCE(length(stage), 0) <= 200) AND (COALESCE(length(reason), 0) <= 500) AND (COALESCE(length(quoted_evidence), 0) <= 500)`),
]);

export const fetchRun = pgTable("fetch_run", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "fetch_run_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobSourceId: bigint("job_source_id", { mode: "number" }).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	seen: integer(),
	new: integer(),
	closed: integer(),
	error: text(),
}, (table) => [
	index("fetch_run_source_idx").using("btree", table.jobSourceId.asc().nullsLast().op("int8_ops")),
	index("fetch_run_started_idx").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.jobSourceId],
			foreignColumns: [jobSource.id],
			name: "fetch_run_job_source_id_fkey"
		}),
]);

export const jobDailyStat = pgTable("job_daily_stat", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "job_daily_stat_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	day: date().notNull(),
	views: integer().default(0).notNull(),
	applyClicks: integer("apply_clicks").default(0).notNull(),
}, (table) => [
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "job_daily_stat_job_id_fkey"
		}).onDelete("cascade"),
	unique("job_daily_stat_job_id_day_key").on(table.jobId, table.day),
]);

export const candidateAccount = pgTable("candidate_account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("candidate_account_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [candidateUser.id],
			name: "candidate_account_user_id_fkey"
		}).onDelete("cascade"),
	unique("candidate_account_provider_unique").on(table.accountId, table.providerId),
]);

export const candidateVerification = pgTable("candidate_verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("candidate_verification_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("candidate_verification_identifier_idx").using("btree", table.identifier.asc().nullsLast().op("text_ops")),
]);

export const candidateRateLimit = pgTable("candidate_rate_limit", {
	id: text().primaryKey().notNull(),
	key: text().notNull(),
	count: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (table) => [
	index("candidate_rate_limit_last_idx").using("btree", table.lastRequest.asc().nullsLast().op("int8_ops")),
	unique("candidate_rate_limit_key_key").on(table.key),
]);

export const candidateUser = pgTable("candidate_user", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").notNull(),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	suspendedAt: timestamp("suspended_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	inactiveWarnedAt: timestamp("inactive_warned_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("candidate_user_active_idx").using("btree", table.lastActiveAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(deleted_at IS NULL)`),
	index("candidate_user_deleted_idx").using("btree", table.deletedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(deleted_at IS NOT NULL)`),
	index("candidate_user_unverified_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(email_verified = false)`),
	index("candidate_user_warned_idx").using("btree", table.inactiveWarnedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(inactive_warned_at IS NOT NULL)`),
	unique("candidate_user_email_key").on(table.email),
]);

export const candidateSession = pgTable("candidate_session", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
}, (table) => [
	index("candidate_session_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("candidate_session_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [candidateUser.id],
			name: "candidate_session_user_id_fkey"
		}).onDelete("cascade"),
	unique("candidate_session_token_key").on(table.token),
]);

export const candidateProfile = pgTable("candidate_profile", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "candidate_profile_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	fullName: text("full_name"),
	phone: text(),
	occupationCode: text("occupation_code"),
	yearsExperience: smallint("years_experience"),
	hasRelevantDegree: boolean("has_relevant_degree"),
	degreeField: text("degree_field"),
	degreeAwardedMonth: date("degree_awarded_month"),
	registrationBody: text("registration_body"),
	registrationNumber: text("registration_number"),
	registrationStatus: text("registration_status"),
	locationKind: text("location_kind"),
	currentStamp: text("current_stamp"),
	visibleToEmployers: boolean("visible_to_employers").default(false).notNull(),
	visibleFields: text("visible_fields").array(),
}, (table) => [
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "candidate_profile_candidate_user_id_fkey"
		}).onDelete("cascade"),
	unique("candidate_profile_candidate_user_id_key").on(table.candidateUserId),
	check("candidate_profile_visible_to_employers_check", sql`visible_to_employers = false`),
	check("candidate_profile_years_experience_check", sql`(years_experience >= 0) AND (years_experience <= 60)`),
	check("candidate_profile_registration_status_check", sql`registration_status = ANY (ARRAY['none'::text, 'in_progress'::text, 'registered'::text])`),
	check("candidate_profile_location_kind_check", sql`location_kind = ANY (ARRAY['abroad'::text, 'ireland'::text])`),
	check("candidate_profile_check", sql`(current_stamp IS NULL) OR (location_kind = 'ireland'::text)`),
	check("candidate_profile_check1", sql`(degree_awarded_month IS NULL) OR ((has_relevant_degree IS TRUE) AND (EXTRACT(day FROM degree_awarded_month) = (1)::numeric))`),
]);

export const candidateCv = pgTable("candidate_cv", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "candidate_cv_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	storageKey: text("storage_key").notNull(),
	fileName: text("file_name").notNull(),
	contentType: text("content_type").notNull(),
	sizeBytes: integer("size_bytes").notNull(),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "candidate_cv_candidate_user_id_fkey"
		}).onDelete("cascade"),
	unique("candidate_cv_candidate_user_id_key").on(table.candidateUserId),
	check("candidate_cv_content_type_check", sql`content_type = ANY (ARRAY['pdf'::text, 'docx'::text])`),
	check("candidate_cv_size_bytes_check", sql`(size_bytes >= 1) AND (size_bytes <= 10485760)`),
]);

export const savedJob = pgTable("saved_job", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "saved_job_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("saved_job_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "saved_job_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "saved_job_job_id_fkey"
		}),
	unique("saved_job_candidate_user_id_job_id_key").on(table.candidateUserId, table.jobId),
]);

export const trackerEntry = pgTable("tracker_entry", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "tracker_entry_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	route: text().notNull(),
	origin: text().notNull(),
	stage: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	applicationId: bigint("application_id", { mode: "number" }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("tracker_entry_application_idx").using("btree", table.applicationId.asc().nullsLast().op("int8_ops")),
	index("tracker_entry_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "tracker_entry_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "tracker_entry_job_id_fkey"
		}),
	foreignKey({
			columns: [table.applicationId],
			foreignColumns: [application.id],
			name: "tracker_entry_application_id_fkey"
		}).onDelete("set null"),
	unique("tracker_entry_candidate_user_id_job_id_key").on(table.candidateUserId, table.jobId),
	check("tracker_entry_route_check", sql`route = ANY (ARRAY['redirect'::text, 'on_site'::text])`),
	check("tracker_entry_origin_check", sql`origin = ANY (ARRAY['did_you_apply_yes'::text, 'mark_applied'::text, 'on_site'::text])`),
	check("tracker_entry_check", sql`((route = 'redirect'::text) AND (stage = ANY (ARRAY['applied'::text, 'interview'::text, 'offer'::text, 'rejected'::text, 'withdrawn'::text]))) OR ((route = 'on_site'::text) AND (stage = ANY (ARRAY['applied'::text, 'viewed'::text, 'shortlisted'::text, 'rejected'::text, 'offer'::text, 'hired'::text, 'withdrawn'::text])))`),
]);

export const applyClick = pgTable("apply_click", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "apply_click_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	clickedAt: timestamp("clicked_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	status: text().default('pending').notNull(),
	timesAsked: smallint("times_asked").default(0).notNull(),
	answeredAt: timestamp("answered_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("apply_click_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("apply_click_clicked_idx").using("btree", table.clickedAt.asc().nullsLast().op("timestamptz_ops")),
	index("apply_click_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("apply_click_open_unique").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops"), table.jobId.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['pending'::text, 'not_yet'::text]))`),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "apply_click_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "apply_click_job_id_fkey"
		}),
	check("apply_click_status_check", sql`status = ANY (ARRAY['pending'::text, 'not_yet'::text, 'yes'::text, 'no'::text, 'expired'::text])`),
	check("apply_click_times_asked_check", sql`(times_asked >= 0) AND (times_asked <= 2)`),
]);

export const alert = pgTable("alert", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "alert_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id").notNull(),
	occupationCode: text("occupation_code"),
	sector: text(),
	county: text(),
	badge: text(),
	salaryMin: integer("salary_min"),
	searchText: text("search_text"),
	frequency: text().notNull(),
	status: text().default('active').notNull(),
	pauseReason: text("pause_reason"),
	unsubscribeToken: text("unsubscribe_token").notNull(),
	lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("alert_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("alert_send_idx").using("btree", table.frequency.asc().nullsLast().op("text_ops"), table.lastSentAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "alert_candidate_user_id_fkey"
		}).onDelete("cascade"),
	unique("alert_unsubscribe_token_key").on(table.unsubscribeToken),
	check("alert_frequency_check", sql`frequency = ANY (ARRAY['daily'::text, 'weekly'::text])`),
	check("alert_status_check", sql`status = ANY (ARRAY['active'::text, 'paused'::text, 'unsubscribed'::text])`),
	check("alert_pause_reason_check", sql`pause_reason = ANY (ARRAY['dormant'::text, 'stamp_4'::text, 'candidate'::text])`),
]);

export const portalAccount = pgTable("portal_account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("portal_account_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [portalUser.id],
			name: "portal_account_user_id_fkey"
		}).onDelete("cascade"),
	unique("portal_account_provider_unique").on(table.accountId, table.providerId),
]);

export const portalVerification = pgTable("portal_verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("portal_verification_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("portal_verification_identifier_idx").using("btree", table.identifier.asc().nullsLast().op("text_ops")),
]);

export const portalRateLimit = pgTable("portal_rate_limit", {
	id: text().primaryKey().notNull(),
	key: text().notNull(),
	count: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (table) => [
	index("portal_rate_limit_last_idx").using("btree", table.lastRequest.asc().nullsLast().op("int8_ops")),
	unique("portal_rate_limit_key_key").on(table.key),
]);

export const portalUser = pgTable("portal_user", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").notNull(),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	status: text().default('active').notNull(),
	blockedAt: timestamp("blocked_at", { withTimezone: true, mode: 'string' }),
	blockedReasonCode: text("blocked_reason_code"),
	lastActiveAt: timestamp("last_active_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	unique("portal_user_email_key").on(table.email),
	check("portal_user_status_check", sql`status = ANY (ARRAY['active'::text, 'blocked'::text])`),
]);

export const portalSession = pgTable("portal_session", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
}, (table) => [
	index("portal_session_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("portal_session_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [portalUser.id],
			name: "portal_session_user_id_fkey"
		}).onDelete("cascade"),
	unique("portal_session_token_key").on(table.token),
]);

export const organisation = pgTable("organisation", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "organisation_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	slug: text().notNull(),
	displayName: text("display_name").notNull(),
	website: text(),
	logoUrl: text("logo_url"),
	shortDescription: text("short_description"),
	county: text(),
	naceCode: text("nace_code"),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	kind: text().notNull(),
	status: text().default('unclaimed').notNull(),
	signupPath: text("signup_path"),
	croNumber: text("cro_number"),
	wrcLicenceNumber: text("wrc_licence_number"),
	isBigCompany: boolean("is_big_company").default(false).notNull(),
	permitHistory: text("permit_history").default('not_linked').notNull(),
	memberLimit: integer("member_limit").default(10).notNull(),
	restrictedUntil: timestamp("restricted_until", { withTimezone: true, mode: 'string' }),
	claimsRemovedAt: timestamp("claims_removed_at", { withTimezone: true, mode: 'string' }),
	statusChangedAt: timestamp("status_changed_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	mergedIntoId: bigint("merged_into_id", { mode: "number" }),
	sponsorSort: integer("sponsor_sort").default(sql`'-1'`).notNull(),
	logoKey: text("logo_key"),
}, (table) => [
	uniqueIndex("organisation_cro_unique").using("btree", table.croNumber.asc().nullsLast().op("text_ops")).where(sql`((cro_number IS NOT NULL) AND (status <> ALL (ARRAY['rejected'::text, 'closed'::text])) AND (merged_into_id IS NULL))`),
	uniqueIndex("organisation_wrc_unique").using("btree", table.wrcLicenceNumber.asc().nullsLast().op("text_ops")).where(sql`((wrc_licence_number IS NOT NULL) AND (status <> ALL (ARRAY['rejected'::text, 'closed'::text])) AND (merged_into_id IS NULL))`),
	foreignKey({
			columns: [table.mergedIntoId],
			foreignColumns: [table.id],
			name: "organisation_merged_into_id_fkey"
		}),
	unique("organisation_slug_key").on(table.slug),
	check("organisation_sponsor_sort_check", sql`sponsor_sort >= '-1'::integer`),
	check("organisation_kind_check", sql`kind = ANY (ARRAY['employer'::text, 'agency'::text, 'public_body'::text])`),
	check("organisation_status_check", sql`status = ANY (ARRAY['unclaimed'::text, 'pending_review'::text, 'needs_info'::text, 'verified'::text, 'verified_restricted'::text, 'suspended'::text, 'rejected'::text, 'banned'::text, 'closed'::text])`),
	check("organisation_signup_path_check", sql`signup_path = ANY (ARRAY['dete_claim'::text, 'first_time'::text, 'agency'::text, 'admin'::text])`),
	check("organisation_permit_history_check", sql`permit_history = ANY (ARRAY['has_history'::text, 'first_time'::text, 'not_linked'::text])`),
	check("organisation_check", sql`(wrc_licence_number IS NULL) OR (kind = 'agency'::text)`),
	check("organisation_check1", sql`merged_into_id <> id`),
	check("organisation_logo_key_check", sql`logo_key ~ '^logo/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(png|jpg|webp)$'::text`),
	check("organisation_member_limit_check", sql`(member_limit >= 1) AND (member_limit <= 50)`),
]);

export const organisationName = pgTable("organisation_name", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "organisation_name_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	name: text().notNull(),
	normalisedName: text("normalised_name").notNull(),
	kind: text().notNull(),
	source: text().notNull(),
	croNumber: text("cro_number"),
	confirmedByStaffId: text("confirmed_by_staff_id"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("organisation_name_alias_unique").using("btree", table.normalisedName.asc().nullsLast().op("text_ops")).where(sql`(kind = 'alias'::text)`),
	uniqueIndex("organisation_name_cro_unique").using("btree", table.croNumber.asc().nullsLast().op("text_ops"), table.normalisedName.asc().nullsLast().op("text_ops")).where(sql`(cro_number IS NOT NULL)`),
	uniqueIndex("organisation_name_legal_nocro_unique").using("btree", table.normalisedName.asc().nullsLast().op("text_ops")).where(sql`((kind = 'legal'::text) AND (cro_number IS NULL))`),
	index("organisation_name_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("organisation_name_staff_idx").using("btree", table.confirmedByStaffId.asc().nullsLast().op("text_ops")),
	index("organisation_name_trgm").using("gin", table.normalisedName.asc().nullsLast().op("gin_trgm_ops")),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "organisation_name_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.confirmedByStaffId],
			foreignColumns: [staffUser.id],
			name: "organisation_name_confirmed_by_staff_id_fkey"
		}),
	check("organisation_name_kind_check", sql`kind = ANY (ARRAY['legal'::text, 'alias'::text])`),
	check("organisation_name_source_check", sql`source = ANY (ARRAY['dete'::text, 'cro'::text, 'job_site'::text, 'admin'::text, 'public_body_list'::text])`),
]);

export const organisationDomain = pgTable("organisation_domain", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "organisation_domain_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	domain: text().notNull(),
	source: text().notNull(),
	addedByStaffId: text("added_by_staff_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("organisation_domain_domain_idx").using("btree", table.domain.asc().nullsLast().op("text_ops")),
	index("organisation_domain_staff_idx").using("btree", table.addedByStaffId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "organisation_domain_organisation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.addedByStaffId],
			foreignColumns: [staffUser.id],
			name: "organisation_domain_added_by_staff_id_fkey"
		}),
	unique("organisation_domain_organisation_id_domain_key").on(table.organisationId, table.domain),
	check("organisation_domain_domain_check", sql`domain = lower(domain)`),
	check("organisation_domain_source_check", sql`source = ANY (ARRAY['seed'::text, 'admin'::text])`),
]);

export const croCompany = pgTable("cro_company", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "cro_company_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	croNumber: text("cro_number").notNull(),
	name: text().notNull(),
	normalisedName: text("normalised_name").notNull(),
	status: text().notNull(),
	lastSeenOn: date("last_seen_on").notNull(),
	companyType: text("company_type"),
	county: text(),
}, (table) => [
	index("cro_company_trgm").using("gin", table.normalisedName.asc().nullsLast().op("gin_trgm_ops")),
	unique("cro_company_cro_number_key").on(table.croNumber),
]);

export const detePermitCount = pgTable("dete_permit_count", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "dete_permit_count_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	deteName: text("dete_name").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationNameId: bigint("organisation_name_id", { mode: "number" }),
	year: smallint().notNull(),
	month: smallint(),
	permits: integer().notNull(),
	sourceFile: text("source_file"),
	importedAt: timestamp("imported_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("dete_permit_count_name_idx").using("btree", table.organisationNameId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.organisationNameId],
			foreignColumns: [organisationName.id],
			name: "dete_permit_count_organisation_name_id_fkey"
		}),
	unique("dete_permit_count_dete_name_year_month_key").on(table.deteName, table.year, table.month),
	check("dete_permit_count_month_check", sql`(month >= 1) AND (month <= 12)`),
]);

export const detePermitRise = pgTable("dete_permit_rise", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "dete_permit_rise_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	foundAt: timestamp("found_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deteName: text("dete_name").notNull(),
	year: smallint().notNull(),
	permitsBefore: integer("permits_before").notNull(),
	permitsAfter: integer("permits_after").notNull(),
}, (table) => [
	index("dete_permit_rise_found_idx").using("btree", table.foundAt.asc().nullsLast().op("timestamptz_ops")),
	check("dete_permit_rise_check", sql`permits_after > permits_before`),
]);

export const signupNoCount = pgTable("signup_no_count", {
	day: date().primaryKey().notNull(),
	count: integer().notNull(),
}, () => [
	check("signup_no_count_count_check", sql`count > 0`),
]);

export const wrcLicence = pgTable("wrc_licence", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "wrc_licence_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	licenceNumber: text("licence_number").notNull(),
	agencyName: text("agency_name"),
	tradingName: text("trading_name"),
	address: text(),
	county: text(),
	firstSeenOn: date("first_seen_on"),
	lastSeenOn: date("last_seen_on"),
	missedImports: smallint("missed_imports").default(0).notNull(),
}, (table) => [
	unique("wrc_licence_licence_number_key").on(table.licenceNumber),
	check("wrc_licence_missed_imports_check", sql`missed_imports >= 0`),
]);

export const registerImport = pgTable("register_import", {
	source: text().primaryKey().notNull(),
	validator: text(),
	importedOn: date("imported_on").notNull(),
	rowCount: integer("row_count").notNull(),
}, () => [
	check("register_import_source_check", sql`source = ANY (ARRAY['cro'::text, 'wrc'::text])`),
	check("register_import_row_count_check", sql`row_count >= 0`),
]);

export const membership = pgTable("membership", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "membership_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	portalUserId: text("portal_user_id"),
	invitedEmail: text("invited_email"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	invitedByMembershipId: bigint("invited_by_membership_id", { mode: "number" }),
	inviteTokenHash: text("invite_token_hash"),
	inviteExpiresAt: timestamp("invite_expires_at", { withTimezone: true, mode: 'string' }),
	joinedAt: timestamp("joined_at", { withTimezone: true, mode: 'string' }),
	removedAt: timestamp("removed_at", { withTimezone: true, mode: 'string' }),
	role: text().notNull(),
	isSigner: boolean("is_signer").default(false).notNull(),
	status: text().notNull(),
}, (table) => [
	uniqueIndex("membership_invite_token_unique").using("btree", table.inviteTokenHash.asc().nullsLast().op("text_ops")).where(sql`(invite_token_hash IS NOT NULL)`),
	index("membership_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("membership_org_invite_unique").using("btree", sql`organisation_id`, sql`lower(invited_email)`).where(sql`(status = 'invited'::text)`),
	uniqueIndex("membership_org_user_unique").using("btree", table.organisationId.asc().nullsLast().op("text_ops"), table.portalUserId.asc().nullsLast().op("text_ops")).where(sql`(status <> 'removed'::text)`),
	index("membership_user_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	uniqueIndex("one_company_per_login").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['active'::text, 'awaiting_approval'::text]))`),
	uniqueIndex("one_owner_per_org").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")).where(sql`((role = 'account_owner'::text) AND (status = 'active'::text))`),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "membership_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "membership_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.invitedByMembershipId],
			foreignColumns: [table.id],
			name: "membership_invited_by_membership_id_fkey"
		}),
	unique("membership_id_organisation_id_key").on(table.id, table.organisationId),
	check("membership_role_check", sql`role = ANY (ARRAY['viewer'::text, 'poster'::text, 'recruiter'::text, 'account_owner'::text])`),
	check("membership_status_check", sql`status = ANY (ARRAY['invited'::text, 'join_requested'::text, 'awaiting_approval'::text, 'active'::text, 'removed'::text])`),
	check("membership_check", sql`(portal_user_id IS NOT NULL) OR (invited_email IS NOT NULL) OR (status = 'removed'::text)`),
	check("membership_check1", sql`(role <> 'viewer'::text) OR (NOT is_signer)`),
]);

export const sponsorshipStatement = pgTable("sponsorship_statement", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "sponsorship_statement_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	kind: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentTextId: bigint("consent_text_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	signerMembershipId: bigint("signer_membership_id", { mode: "number" }),
	signerName: text("signer_name"),
	signerTitle: text("signer_title"),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	onBehalfOfName: text("on_behalf_of_name"),
	writtenAuthorityOnFile: boolean("written_authority_on_file").default(false).notNull(),
	confirmationFileKey: text("confirmation_file_key"),
	enteredByStaffId: text("entered_by_staff_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
	supersededAt: timestamp("superseded_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("one_current_statement").using("btree", table.jobId.asc().nullsLast().op("int8_ops")).where(sql`(superseded_at IS NULL)`),
	index("sponsorship_statement_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	index("sponsorship_statement_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	index("sponsorship_statement_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("sponsorship_statement_signer_idx").using("btree", table.signerMembershipId.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")),
	index("sponsorship_statement_staff_idx").using("btree", table.enteredByStaffId.asc().nullsLast().op("text_ops")),
	index("sponsorship_statement_text_idx").using("btree", table.consentTextId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "sponsorship_statement_job_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "sponsorship_statement_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.consentTextId],
			foreignColumns: [consentText.id],
			name: "sponsorship_statement_consent_text_id_fkey"
		}),
	foreignKey({
			columns: [table.enteredByStaffId],
			foreignColumns: [staffUser.id],
			name: "sponsorship_statement_entered_by_staff_id_fkey"
		}),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "sponsorship_statement_approval_request_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId, table.signerMembershipId],
			foreignColumns: [membership.id, membership.organisationId],
			name: "sponsorship_statement_signer_membership_id_organisation_id_fkey"
		}),
	check("sponsorship_statement_kind_check", sql`kind = ANY (ARRAY['own_company'::text, 'on_behalf_of_client'::text, 'admin_on_behalf'::text])`),
	check("sponsorship_statement_check", sql`(kind <> 'on_behalf_of_client'::text) OR ((on_behalf_of_name IS NOT NULL) AND written_authority_on_file)`),
	check("sponsorship_statement_check1", sql`((kind = 'admin_on_behalf'::text) AND (confirmation_file_key IS NOT NULL) AND (approval_request_id IS NOT NULL) AND (signer_membership_id IS NULL)) OR ((kind <> 'admin_on_behalf'::text) AND (signer_membership_id IS NOT NULL))`),
]);

export const payFloor = pgTable("pay_floor", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "pay_floor_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	roleFamily: text("role_family").notNull(),
	floorEur: integer("floor_eur").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentTextId: bigint("consent_text_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	signerMembershipId: bigint("signer_membership_id", { mode: "number" }).notNull(),
	signerName: text("signer_name"),
	signerTitle: text("signer_title"),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	validUntil: timestamp("valid_until", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending_check').notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	checkedByStaffId: text("checked_by_staff_id"),
	checkedAt: timestamp("checked_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	replacesId: bigint("replaces_id", { mode: "number" }),
}, (table) => [
	index("pay_floor_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("pay_floor_one_active").using("btree", table.organisationId.asc().nullsLast().op("int8_ops"), table.roleFamily.asc().nullsLast().op("int8_ops")).where(sql`(status = 'active'::text)`),
	uniqueIndex("pay_floor_one_pending").using("btree", table.organisationId.asc().nullsLast().op("int8_ops"), table.roleFamily.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending_check'::text)`),
	index("pay_floor_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("pay_floor_replaces_idx").using("btree", table.replacesId.asc().nullsLast().op("int8_ops")),
	index("pay_floor_signer_idx").using("btree", table.signerMembershipId.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")),
	index("pay_floor_staff_idx").using("btree", table.checkedByStaffId.asc().nullsLast().op("text_ops")),
	index("pay_floor_text_idx").using("btree", table.consentTextId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "pay_floor_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.consentTextId],
			foreignColumns: [consentText.id],
			name: "pay_floor_consent_text_id_fkey"
		}),
	foreignKey({
			columns: [table.checkedByStaffId],
			foreignColumns: [staffUser.id],
			name: "pay_floor_checked_by_staff_id_fkey"
		}),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "pay_floor_approval_request_id_fkey"
		}),
	foreignKey({
			columns: [table.replacesId],
			foreignColumns: [table.id],
			name: "pay_floor_replaces_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId, table.signerMembershipId],
			foreignColumns: [membership.id, membership.organisationId],
			name: "pay_floor_signer_membership_id_organisation_id_fkey"
		}),
	check("pay_floor_floor_eur_check", sql`floor_eur > 0`),
	check("pay_floor_status_check", sql`status = ANY (ARRAY['pending_check'::text, 'active'::text, 'expired'::text, 'replaced'::text, 'withdrawn'::text, 'rejected'::text, 'found_false'::text])`),
	check("pay_floor_check", sql`valid_until > signed_at`),
	check("pay_floor_check1", sql`(status <> 'active'::text) OR (approval_request_id IS NOT NULL)`),
]);

export const staffUser = pgTable("staff_user", {
	id: text().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").notNull(),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	status: text().default('active').notNull(),
}, (table) => [
	unique("staff_user_email_key").on(table.email),
	check("staff_user_status_check", sql`status = ANY (ARRAY['active'::text, 'disabled'::text])`),
]);

export const staffSession = pgTable("staff_session", {
	id: text().primaryKey().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	token: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id").notNull(),
}, (table) => [
	index("staff_session_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("staff_session_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [staffUser.id],
			name: "staff_session_user_id_fkey"
		}).onDelete("cascade"),
	unique("staff_session_token_key").on(table.token),
]);

export const staffAccount = pgTable("staff_account", {
	id: text().primaryKey().notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).notNull(),
}, (table) => [
	index("staff_account_user_id_idx").using("btree", table.userId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [staffUser.id],
			name: "staff_account_user_id_fkey"
		}).onDelete("cascade"),
	unique("staff_account_provider_unique").on(table.accountId, table.providerId),
]);

export const staffVerification = pgTable("staff_verification", {
	id: text().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (table) => [
	index("staff_verification_expires_idx").using("btree", table.expiresAt.asc().nullsLast().op("timestamptz_ops")),
	index("staff_verification_identifier_idx").using("btree", table.identifier.asc().nullsLast().op("text_ops")),
]);

export const staffRateLimit = pgTable("staff_rate_limit", {
	id: text().primaryKey().notNull(),
	key: text().notNull(),
	count: integer().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	lastRequest: bigint("last_request", { mode: "number" }).notNull(),
}, (table) => [
	index("staff_rate_limit_last_idx").using("btree", table.lastRequest.asc().nullsLast().op("int8_ops")),
	unique("staff_rate_limit_key_key").on(table.key),
]);

export const staffRole = pgTable("staff_role", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "staff_role_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	staffUserId: text("staff_user_id").notNull(),
	role: text().notNull(),
	grantedByStaffUserId: text("granted_by_staff_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
	seededByOwner: boolean("seeded_by_owner").default(false).notNull(),
}, (table) => [
	index("staff_role_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	index("staff_role_granted_by_idx").using("btree", table.grantedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.staffUserId],
			foreignColumns: [staffUser.id],
			name: "staff_role_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.grantedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "staff_role_granted_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "staff_role_approval_request_id_fkey"
		}),
	unique("staff_role_staff_user_id_role_key").on(table.staffUserId, table.role),
	check("staff_role_role_check", sql`role = ANY (ARRAY['account_reviewer'::text, 'fetched_job_reviewer'::text, 'rules_data_editor'::text, 'trust_and_safety'::text, 'services_case_handler'::text, 'content_editor'::text, 'administrator'::text])`),
	check("staff_role_check", sql`(approval_request_id IS NOT NULL) OR (seeded_by_owner IS TRUE)`),
]);

export const servicesCase = pgTable("services_case", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "services_case_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	requesterErasedAt: timestamp("requester_erased_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	permitType: text("permit_type"),
	offerDetails: jsonb("offer_details"),
	payer: text(),
	status: text().default('received').notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closeReason: text("close_reason"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentRecordId: bigint("consent_record_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	employerContactConsentRecordId: bigint("employer_contact_consent_record_id", { mode: "number" }),
	assignedStaffUserId: text("assigned_staff_user_id"),
	dedupeKey: text("dedupe_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("services_case_board_idx").using("btree", table.status.asc().nullsLast().op("int8_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("text_ops")).where(sql`(status <> 'closed'::text)`),
	index("services_case_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	uniqueIndex("services_case_candidate_open").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops"), table.jobId.asc().nullsLast().op("int8_ops")).where(sql`((status <> 'closed'::text) AND (candidate_user_id IS NOT NULL))`),
	index("services_case_consent_idx").using("btree", table.consentRecordId.asc().nullsLast().op("int8_ops")),
	index("services_case_contact_consent_idx").using("btree", table.employerContactConsentRecordId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("services_case_dedupe_unique").using("btree", table.dedupeKey.asc().nullsLast().op("text_ops")).where(sql`(dedupe_key IS NOT NULL)`),
	index("services_case_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	index("services_case_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("services_case_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	index("services_case_staff_idx").using("btree", table.assignedStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "services_case_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "services_case_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "services_case_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "services_case_job_id_fkey"
		}),
	foreignKey({
			columns: [table.consentRecordId],
			foreignColumns: [consentRecord.id],
			name: "services_case_consent_record_id_fkey"
		}),
	foreignKey({
			columns: [table.employerContactConsentRecordId],
			foreignColumns: [consentRecord.id],
			name: "services_case_employer_contact_consent_record_id_fkey"
		}),
	foreignKey({
			columns: [table.assignedStaffUserId],
			foreignColumns: [staffUser.id],
			name: "services_case_assigned_staff_user_id_fkey"
		}),
	check("services_case_payer_check", sql`payer = ANY (ARRAY['employer'::text, 'agency'::text])`),
	check("services_case_status_check", sql`status = ANY (ARRAY['received'::text, 'documents_needed'::text, 'waiting_for_employer'::text, 'submitted'::text, 'decision'::text, 'closed'::text])`),
	check("services_case_close_reason_check", sql`close_reason = ANY (ARRAY['decided'::text, 'employer_not_engaged'::text, 'withdrawn'::text, 'referred_to_solicitor'::text, 'no_reply'::text])`),
	check("services_case_check", sql`(num_nonnulls(candidate_user_id, portal_user_id) = 1) OR (requester_erased_at IS NOT NULL)`),
	check("services_case_check1", sql`(portal_user_id IS NULL) OR (dedupe_key IS NOT NULL)`),
	check("services_case_check2", sql`(status <> 'closed'::text) OR ((closed_at IS NOT NULL) AND (close_reason IS NOT NULL))`),
]);

export const caseNote = pgTable("case_note", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "case_note_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	servicesCaseId: bigint("services_case_id", { mode: "number" }).notNull(),
	authorStaffUserId: text("author_staff_user_id").notNull(),
	body: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("case_note_author_idx").using("btree", table.authorStaffUserId.asc().nullsLast().op("text_ops")),
	index("case_note_case_idx").using("btree", table.servicesCaseId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.servicesCaseId],
			foreignColumns: [servicesCase.id],
			name: "case_note_services_case_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.authorStaffUserId],
			foreignColumns: [staffUser.id],
			name: "case_note_author_staff_user_id_fkey"
		}),
]);

export const caseDocument = pgTable("case_document", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "case_document_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	servicesCaseId: bigint("services_case_id", { mode: "number" }).notNull(),
	storageKey: text("storage_key"),
	fileName: text("file_name"),
	contentType: text("content_type"),
	byteSize: integer("byte_size"),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	copyDeletedAt: timestamp("copy_deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("case_document_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("case_document_case_idx").using("btree", table.servicesCaseId.asc().nullsLast().op("int8_ops")),
	index("case_document_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	index("case_document_staff_idx").using("btree", table.staffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.servicesCaseId],
			foreignColumns: [servicesCase.id],
			name: "case_document_services_case_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "case_document_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "case_document_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.staffUserId],
			foreignColumns: [staffUser.id],
			name: "case_document_staff_user_id_fkey"
		}),
	check("case_document_check", sql`num_nonnulls(candidate_user_id, portal_user_id, staff_user_id) <= 1`),
	check("case_document_check1", sql`(storage_key IS NULL) = (copy_deleted_at IS NOT NULL)`),
]);

export const caseQuote = pgTable("case_quote", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "case_quote_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	servicesCaseId: bigint("services_case_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	amountEur: integer("amount_eur").notNull(),
	status: text().default('draft').notNull(),
	invoiceNumber: text("invoice_number"),
	quotedByStaffUserId: text("quoted_by_staff_user_id"),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	invoicedAt: timestamp("invoiced_at", { withTimezone: true, mode: 'string' }),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("case_quote_case_idx").using("btree", table.servicesCaseId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("case_quote_invoice_unique").using("btree", table.invoiceNumber.asc().nullsLast().op("text_ops")).where(sql`(invoice_number IS NOT NULL)`),
	uniqueIndex("case_quote_open_unique").using("btree", table.servicesCaseId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['draft'::text, 'sent'::text]))`),
	index("case_quote_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("case_quote_staff_idx").using("btree", table.quotedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.servicesCaseId],
			foreignColumns: [servicesCase.id],
			name: "case_quote_services_case_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "case_quote_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.quotedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "case_quote_quoted_by_staff_user_id_fkey"
		}),
	check("case_quote_amount_eur_check", sql`amount_eur > 0`),
	check("case_quote_status_check", sql`status = ANY (ARRAY['draft'::text, 'sent'::text, 'accepted'::text, 'declined'::text, 'invoiced'::text, 'paid'::text, 'cancelled'::text])`),
]);

export const contentPage = pgTable("content_page", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "content_page_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	kind: text().notNull(),
	slug: text().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	sourceUrl: text("source_url"),
	checkedOn: date("checked_on"),
	status: text().default('draft').notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	updatedByStaffUserId: text("updated_by_staff_user_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("content_page_feed_idx").using("btree", table.kind.asc().nullsLast().op("int8_ops"), table.publishedAt.desc().nullsFirst().op("int8_ops"), table.id.desc().nullsFirst().op("text_ops")).where(sql`(status = 'published'::text)`),
	index("content_page_staff_idx").using("btree", table.updatedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("content_page_stale_idx").using("btree", table.checkedOn.asc().nullsLast().op("date_ops")).where(sql`((kind = 'guide'::text) AND (status = 'published'::text))`),
	foreignKey({
			columns: [table.updatedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "content_page_updated_by_staff_user_id_fkey"
		}),
	unique("content_page_kind_slug_key").on(table.kind, table.slug),
	check("content_page_kind_check", sql`kind = ANY (ARRAY['guide'::text, 'update'::text, 'help'::text])`),
	check("content_page_status_check", sql`status = ANY (ARRAY['draft'::text, 'published'::text, 'withdrawn'::text])`),
	check("content_page_check", sql`(status <> 'published'::text) OR (kind = 'help'::text) OR ((source_url IS NOT NULL) AND (checked_on IS NOT NULL))`),
	check("content_page_check1", sql`(status <> 'published'::text) OR (published_at IS NOT NULL)`),
]);

export const contactMessage = pgTable("contact_message", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "contact_message_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	surface: text().notNull(),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	fromName: text("from_name"),
	fromEmail: text("from_email"),
	topic: text().notNull(),
	body: text(),
	status: text().default('new').notNull(),
	claimedByStaffUserId: text("claimed_by_staff_user_id"),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("contact_message_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("contact_message_inbox_idx").using("btree", table.status.asc().nullsLast().op("int8_ops"), table.createdAt.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['new'::text, 'claimed'::text]))`),
	index("contact_message_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	index("contact_message_staff_idx").using("btree", table.claimedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "contact_message_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.claimedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "contact_message_claimed_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "contact_message_candidate_user_id_fkey"
		}).onDelete("set null"),
	check("contact_message_check1", sql`(status <> 'closed'::text) OR (closed_at IS NOT NULL)`),
	check("contact_message_check2", sql`((body IS NOT NULL) AND ((char_length(body) >= 1) AND (char_length(body) <= 5000))) OR ((body IS NULL) AND (from_name IS NULL) AND (from_email IS NULL) AND (candidate_user_id IS NULL) AND (portal_user_id IS NULL))`),
	check("contact_message_check", sql`num_nonnulls(candidate_user_id, portal_user_id) <= 1`),
	check("contact_message_surface_check", sql`surface = ANY (ARRAY['candidate_site'::text, 'portal'::text])`),
	check("contact_message_topic_check", sql`topic = ANY (ARRAY['general'::text, 'account'::text, 'data_request'::text, 'other'::text, 'appeal'::text])`),
	check("contact_message_status_check", sql`status = ANY (ARRAY['new'::text, 'claimed'::text, 'answered'::text, 'closed'::text, 'spam'::text])`),
]);

export const report = pgTable("report", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "report_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	targetKind: text("target_kind").notNull(),
	targetWipedAt: timestamp("target_wiped_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	targetJobId: bigint("target_job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	targetOrganisationId: bigint("target_organisation_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	targetMessageId: bigint("target_message_id", { mode: "number" }),
	targetCandidateUserId: text("target_candidate_user_id"),
	reporterCandidateUserId: text("reporter_candidate_user_id"),
	reporterPortalUserId: text("reporter_portal_user_id"),
	reporterWipedAt: timestamp("reporter_wiped_at", { withTimezone: true, mode: 'string' }),
	reason: text().notNull(),
	evidenceText: text("evidence_text"),
	evidenceStorageKey: text("evidence_storage_key"),
	targetSnapshot: jsonb("target_snapshot"),
	status: text().default('open').notNull(),
	decidedByStaffUserId: text("decided_by_staff_user_id"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("report_candidate_open_unique").using("btree", table.reporterCandidateUserId.asc().nullsLast().op("int8_ops"), table.targetJobId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'job_hidden'::text]))`),
	index("report_decided_idx").using("btree", table.decidedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("report_inbox_idx").using("btree", table.status.asc().nullsLast().op("text_ops"), table.createdAt.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'job_hidden'::text]))`),
	index("report_queue_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'job_hidden'::text]))`),
	uniqueIndex("report_portal_open_unique").using("btree", table.reporterPortalUserId.asc().nullsLast().op("text_ops"), table.targetJobId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'job_hidden'::text]))`),
	index("report_reporter_candidate_idx").using("btree", table.reporterCandidateUserId.asc().nullsLast().op("text_ops")),
	index("report_reporter_portal_idx").using("btree", table.reporterPortalUserId.asc().nullsLast().op("text_ops")),
	index("report_target_candidate_idx").using("btree", table.targetCandidateUserId.asc().nullsLast().op("text_ops")),
	index("report_target_job_idx").using("btree", table.targetJobId.asc().nullsLast().op("int8_ops")),
	index("report_target_message_idx").using("btree", table.targetMessageId.asc().nullsLast().op("int8_ops")),
	index("report_target_org_idx").using("btree", table.targetOrganisationId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.targetJobId],
			foreignColumns: [job.id],
			name: "report_target_job_id_fkey"
		}),
	foreignKey({
			columns: [table.targetOrganisationId],
			foreignColumns: [organisation.id],
			name: "report_target_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.targetMessageId],
			foreignColumns: [message.id],
			name: "report_target_message_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.targetCandidateUserId],
			foreignColumns: [candidateUser.id],
			name: "report_target_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.reporterCandidateUserId],
			foreignColumns: [candidateUser.id],
			name: "report_reporter_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.reporterPortalUserId],
			foreignColumns: [portalUser.id],
			name: "report_reporter_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.decidedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "report_decided_by_staff_user_id_fkey"
		}),
	check("report_target_kind_check", sql`target_kind = ANY (ARRAY['job'::text, 'organisation'::text, 'message'::text, 'profile'::text])`),
	check("report_reason_check", sql`reason = ANY (ARRAY['asks_for_money'::text, 'no_sponsorship'::text, 'job_closed'::text, 'wrong_details'::text, 'other'::text])`),
	check("report_status_check", sql`status = ANY (ARRAY['open'::text, 'job_hidden'::text, 'cleared'::text, 'upheld'::text])`),
	check("report_check", sql`(target_wiped_at IS NOT NULL) OR (num_nonnulls(target_job_id, target_organisation_id, target_message_id, target_candidate_user_id) = 1)`),
	check("report_check1", sql`CHECK (
CASE target_kind
    WHEN 'job'::text THEN (num_nonnulls(target_organisation_id, target_message_id, target_candidate_user_id) = 0)
    WHEN 'organisation'::text THEN (num_nonnulls(target_job_id, target_message_id, target_candidate_user_id) = 0)
    WHEN 'message'::text THEN (num_nonnulls(target_job_id, target_organisation_id, target_candidate_user_id) = 0)
    ELSE (num_nonnulls(target_job_id, target_organisation_id, target_message_id) = 0)
END)`),
	check("report_check2", sql`num_nonnulls(reporter_candidate_user_id, reporter_portal_user_id) <= 1`),
	check("report_check3", sql`(status <> ALL (ARRAY['cleared'::text, 'upheld'::text])) OR (num_nonnulls(reporter_candidate_user_id, reporter_portal_user_id) = 0)`),
]);

export const strike = pgTable("strike", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "strike_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	caseKind: text("case_kind").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	payFloorId: bigint("pay_floor_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	reportId: bigint("report_id", { mode: "number" }),
	reasonCode: text("reason_code").notNull(),
	noticeSummary: text("notice_summary"),
	level: smallint(),
	stage: text().default('case_open').notNull(),
	outcome: text(),
	replyDueAt: timestamp("reply_due_at", { withTimezone: true, mode: 'string' }),
	employerReply: text("employer_reply"),
	repliedAt: timestamp("replied_at", { withTimezone: true, mode: 'string' }),
	replyReceivedAt: timestamp("reply_received_at", { withTimezone: true, mode: 'string' }),
	replyEnteredByStaffUserId: text("reply_entered_by_staff_user_id"),
	decidedByStaffUserId: text("decided_by_staff_user_id"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
	appealDueAt: timestamp("appeal_due_at", { withTimezone: true, mode: 'string' }),
	appealText: text("appeal_text"),
	appealedAt: timestamp("appealed_at", { withTimezone: true, mode: 'string' }),
	appealReceivedAt: timestamp("appeal_received_at", { withTimezone: true, mode: 'string' }),
	appealEnteredByStaffUserId: text("appeal_entered_by_staff_user_id"),
	appealDecidedByStaffUserId: text("appeal_decided_by_staff_user_id"),
	appealDecidedAt: timestamp("appeal_decided_at", { withTimezone: true, mode: 'string' }),
	banLiftedAt: timestamp("ban_lifted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("strike_appeal_entered_idx").using("btree", table.appealEnteredByStaffUserId.asc().nullsLast().op("text_ops")),
	index("strike_appeal_idx").using("btree", table.appealDecidedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("strike_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	index("strike_clock_idx").using("btree", table.stage.asc().nullsLast().op("timestamptz_ops"), table.replyDueAt.asc().nullsLast().op("text_ops")).where(sql`((stage <> ALL (ARRAY['upheld'::text, 'overturned'::text])) AND (outcome IS DISTINCT FROM 'cleared'::text))`),
	index("strike_decided_idx").using("btree", table.decidedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("strike_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	index("strike_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	index("strike_pay_floor_idx").using("btree", table.payFloorId.asc().nullsLast().op("int8_ops")),
	index("strike_reply_entered_idx").using("btree", table.replyEnteredByStaffUserId.asc().nullsLast().op("text_ops")),
	index("strike_report_idx").using("btree", table.reportId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("strike_report_org_unique").using("btree", table.reportId.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")).where(sql`(report_id IS NOT NULL)`),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "strike_job_id_fkey"
		}),
	foreignKey({
			columns: [table.payFloorId],
			foreignColumns: [payFloor.id],
			name: "strike_pay_floor_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "strike_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.reportId],
			foreignColumns: [report.id],
			name: "strike_report_id_fkey"
		}),
	foreignKey({
			columns: [table.replyEnteredByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "strike_reply_entered_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.decidedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "strike_decided_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "strike_approval_request_id_fkey"
		}),
	foreignKey({
			columns: [table.appealEnteredByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "strike_appeal_entered_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.appealDecidedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "strike_appeal_decided_by_staff_user_id_fkey"
		}),
	check("strike_check5", sql`appeal_decided_by_staff_user_id <> appeal_entered_by_staff_user_id`),
	check("strike_case_kind_check", sql`case_kind = ANY (ARRAY['false_claim'::text, 'false_pay_floor'::text, 'instant_ban'::text])`),
	check("strike_reason_code_check", sql`reason_code = ANY (ARRAY['false_sponsorship'::text, 'false_pay_floor'::text, 'asks_for_money'::text, 'fake_company'::text, 'fake_job'::text])`),
	check("strike_level_check", sql`(level >= 1) AND (level <= 3)`),
	check("strike_check6", sql`decided_by_staff_user_id <> reply_entered_by_staff_user_id`),
	check("strike_stage_check", sql`stage = ANY (ARRAY['case_open'::text, 'employer_notified'::text, 'reply_window'::text, 'decided'::text, 'applied'::text, 'appealed'::text, 'upheld'::text, 'overturned'::text])`),
	check("strike_outcome_check", sql`outcome = ANY (ARRAY['cleared'::text, 'strike'::text, 'ban'::text])`),
	check("strike_check", sql`(case_kind <> 'instant_ban'::text) OR (level IS NULL)`),
	check("strike_check1", sql`(outcome IS DISTINCT FROM 'strike'::text) OR (level IS NOT NULL)`),
	check("strike_check2", sql`(NOT (((outcome = 'strike'::text) AND (level = ANY (ARRAY[2, 3]))) OR (outcome = 'ban'::text))) OR (approval_request_id IS NOT NULL)`),
	check("strike_check3", sql`appeal_decided_by_staff_user_id <> decided_by_staff_user_id`),
	check("strike_check4", sql`(stage <> ALL (ARRAY['upheld'::text, 'overturned'::text])) OR ((appealed_at IS NOT NULL) AND (appeal_decided_at IS NOT NULL) AND (appeal_decided_by_staff_user_id IS NOT NULL))`),
]);

export const ban = pgTable("ban", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "ban_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	croNumber: text("cro_number"),
	emailDomain: text("email_domain"),
	reasonCode: text("reason_code").notNull(),
	emailAddress: text("email_address"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	strikeId: bigint("strike_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }).notNull(),
}, (table) => [
	index("ban_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("ban_cro_unique").using("btree", table.croNumber.asc().nullsLast().op("text_ops")).where(sql`(cro_number IS NOT NULL)`),
	uniqueIndex("ban_domain_unique").using("btree", table.emailDomain.asc().nullsLast().op("text_ops")).where(sql`(email_domain IS NOT NULL)`),
	uniqueIndex("ban_address_unique").using("btree", table.emailAddress.asc().nullsLast().op("text_ops")).where(sql`(email_address IS NOT NULL)`),
	index("ban_strike_idx").using("btree", table.strikeId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.strikeId],
			foreignColumns: [strike.id],
			name: "ban_strike_id_fkey"
		}),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "ban_approval_request_id_fkey"
		}),
	check("ban_reason_code_check", sql`reason_code = ANY (ARRAY['asks_for_money'::text, 'fake_company'::text, 'fake_job'::text, 'strike_3'::text])`),
	check("ban_check", sql`num_nonnulls(cro_number, email_domain, email_address) >= 1`),
]);

export const consentText = pgTable("consent_text", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "consent_text_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	purpose: text().notNull(),
	version: text().notNull(),
	body: text().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
}, (table) => [
	index("consent_text_approval_idx").using("btree", table.approvalRequestId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "consent_text_approval_request_id_fkey"
		}),
	unique("consent_text_purpose_version_key").on(table.purpose, table.version),
	check("consent_text_purpose_check", sql`purpose = ANY (ARRAY['signup_terms'::text, 'portal_signup_terms'::text, 'privacy_notice'::text, 'visibility'::text, 'application'::text, 'contact_accept'::text, 'services_request'::text, 'employer_contact'::text, 'sponsorship_statement'::text, 'pay_floor'::text])`),
	check("consent_text_check", sql`(approval_request_id IS NULL) OR (purpose = ANY (ARRAY['signup_terms'::text, 'portal_signup_terms'::text, 'privacy_notice'::text]))`),
]);

export const consentRecord = pgTable("consent_record", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "consent_record_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentTextId: bigint("consent_text_id", { mode: "number" }).notNull(),
	givenAt: timestamp("given_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	details: jsonb(),
	subjectErasedAt: timestamp("subject_erased_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("consent_record_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	index("consent_record_erased_idx").using("btree", table.subjectErasedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(subject_erased_at IS NOT NULL)`),
	index("consent_record_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	index("consent_record_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "consent_record_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "consent_record_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.consentTextId],
			foreignColumns: [consentText.id],
			name: "consent_record_consent_text_id_fkey"
		}),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "consent_record_job_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "consent_record_organisation_id_fkey"
		}),
	check("consent_record_check", sql`(num_nonnulls(candidate_user_id, portal_user_id) = 1) OR (subject_erased_at IS NOT NULL)`),
]);

export const notificationPreference = pgTable("notification_preference", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "notification_preference_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	category: text().notNull(),
	channel: text().notNull(),
	enabled: boolean().notNull(),
}, (table) => [
	uniqueIndex("notification_pref_candidate").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.channel.asc().nullsLast().op("text_ops")).where(sql`(candidate_user_id IS NOT NULL)`),
	uniqueIndex("notification_pref_portal").using("btree", table.portalUserId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.channel.asc().nullsLast().op("text_ops")).where(sql`(portal_user_id IS NOT NULL)`),
	uniqueIndex("notification_pref_staff").using("btree", table.staffUserId.asc().nullsLast().op("text_ops"), table.category.asc().nullsLast().op("text_ops"), table.channel.asc().nullsLast().op("text_ops")).where(sql`(staff_user_id IS NOT NULL)`),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "notification_preference_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "notification_preference_portal_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.staffUserId],
			foreignColumns: [staffUser.id],
			name: "notification_preference_staff_user_id_fkey"
		}),
	check("notification_preference_candidate_category", sql`(candidate_user_id IS NULL) OR ((category = ANY (ARRAY['job_alerts'::text, 'account'::text])) AND ((category <> 'account'::text) OR enabled))`),
	check("notification_preference_channel_check", sql`channel = ANY (ARRAY['email'::text, 'in_app'::text])`),
	check("notification_preference_check", sql`num_nonnulls(candidate_user_id, portal_user_id, staff_user_id) = 1`),
]);

export const notification = pgTable("notification", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "notification_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	category: text().notNull(),
	templateKey: text("template_key").notNull(),
	params: jsonb(),
	dedupeKey: text("dedupe_key"),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("notification_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("text_ops"), table.id.desc().nullsFirst().op("timestamptz_ops")).where(sql`(candidate_user_id IS NOT NULL)`),
	index("notification_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("int8_ops"), table.createdAt.desc().nullsFirst().op("int8_ops"), table.id.desc().nullsFirst().op("int8_ops")).where(sql`(portal_user_id IS NOT NULL)`),
	index("notification_read_idx").using("btree", table.readAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(read_at IS NOT NULL)`),
	index("notification_unread_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "notification_candidate_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "notification_portal_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "notification_organisation_id_fkey"
		}),
	unique("notification_dedupe_key_key").on(table.dedupeKey),
	check("notification_check", sql`num_nonnulls(candidate_user_id, portal_user_id) = 1`),
]);

export const featureFlag = pgTable("feature_flag", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "feature_flag_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	key: text().notNull(),
	enabled: boolean().default(false).notNull(),
	setBy: text("set_by"),
	setAt: timestamp("set_at", { withTimezone: true, mode: 'string' }),
	note: text(),
}, (table) => [
	unique("feature_flag_key_key").on(table.key),
	check("feature_flag_key_check", sql`key = ANY (ARRAY['on_site_applications'::text, 'candidate_search'::text, 'contact_requests'::text, 'visibility_switch'::text, 'messaging'::text])`),
]);

export const approvalRequest = pgTable("approval_request", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "approval_request_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	kind: text().notNull(),
	targetTable: text("target_table").notNull(),
	targetId: text("target_id").notNull(),
	change: jsonb(),
	effectiveFrom: timestamp("effective_from", { withTimezone: true, mode: 'string' }),
	reason: text(),
	proposedByStaffUserId: text("proposed_by_staff_user_id").notNull(),
	confirmedByStaffUserId: text("confirmed_by_staff_user_id"),
	status: text().default('pending').notNull(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	appliedAt: timestamp("applied_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("approval_request_confirmed_idx").using("btree", table.confirmedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("approval_request_pending_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops"), table.id.asc().nullsLast().op("int8_ops")).where(sql`(status = 'pending'::text)`),
	uniqueIndex("approval_request_pending_unique").using("btree", table.kind.asc().nullsLast().op("text_ops"), table.targetTable.asc().nullsLast().op("text_ops"), table.targetId.asc().nullsLast().op("text_ops")).where(sql`(status = 'pending'::text)`),
	index("approval_request_proposed_idx").using("btree", table.proposedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.proposedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "approval_request_proposed_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.confirmedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "approval_request_confirmed_by_staff_user_id_fkey"
		}),
	check("approval_request_status_check", sql`status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'refused'::text, 'withdrawn'::text])`),
	check("approval_request_check", sql`confirmed_by_staff_user_id <> proposed_by_staff_user_id`),
	check("approval_request_check1", sql`(status <> 'confirmed'::text) OR (confirmed_by_staff_user_id IS NOT NULL)`),
	check("approval_request_kind_check", sql`kind = ANY (ARRAY['threshold'::text, 'critical_skills_list'::text, 'ineligible_list'::text, 'unclear_role_list'::text, 'public_pay_employer'::text, 'big_company_entry'::text, 'pay_floor'::text, 'strike_2'::text, 'strike_3'::text, 'ban'::text, 'ban_lift'::text, 'manual_post_sponsor_confirmed'::text, 'grant_administrator'::text, 'grant_role'::text, 'terms_privacy_page'::text, 'setting'::text])`),
]);

export const setting = pgTable("setting", {
	key: text().primaryKey().notNull(),
	value: integer(),
	unit: text(),
	isGuess: boolean("is_guess").default(true).notNull(),
	solicitorConfirmedAt: timestamp("solicitor_confirmed_at", { withTimezone: true, mode: 'string' }),
	solicitorNote: text("solicitor_note"),
	updatedByStaffUserId: text("updated_by_staff_user_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("setting_updated_by_idx").using("btree", table.updatedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.updatedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "setting_updated_by_staff_user_id_fkey"
		}),
	check("setting_unit_check", sql`unit = ANY (ARRAY['days'::text, 'months'::text, 'count'::text])`),
	check("setting_value_check", sql`(value IS NULL) OR (value >= 0)`),
]);

export const auditEvent = pgTable("audit_event", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "audit_event_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	kind: text().notNull(),
	actorStaffUserId: text("actor_staff_user_id"),
	actorCandidateUserId: text("actor_candidate_user_id"),
	actorPortalUserId: text("actor_portal_user_id"),
	actorSystem: text("actor_system"),
	roleInForce: text("role_in_force"),
	action: text().notNull(),
	objectType: text("object_type"),
	objectId: text("object_id"),
	subjectCandidateUserId: text("subject_candidate_user_id"),
	changedColumns: text("changed_columns").array(),
	before: jsonb(),
	after: jsonb(),
	reasonCode: text("reason_code"),
	reasonText: text("reason_text"),
	secondStaffUserId: text("second_staff_user_id"),
	relatedCase: text("related_case"),
	source: text(),
}, (table) => [
	index("audit_event_actor_candidate_idx").using("btree", table.actorCandidateUserId.asc().nullsLast().op("text_ops")).where(sql`(actor_candidate_user_id IS NOT NULL)`),
	index("audit_event_actor_portal_idx").using("btree", table.actorPortalUserId.asc().nullsLast().op("text_ops")).where(sql`(actor_portal_user_id IS NOT NULL)`),
	index("audit_event_actor_staff_idx").using("btree", table.actorStaffUserId.asc().nullsLast().op("text_ops")).where(sql`(actor_staff_user_id IS NOT NULL)`),
	index("audit_event_at_idx").using("btree", table.at.asc().nullsLast().op("int8_ops"), table.id.asc().nullsLast().op("int8_ops")),
	index("audit_event_object_idx").using("btree", table.objectId.asc().nullsLast().op("text_ops"), table.objectType.asc().nullsLast().op("text_ops")).where(sql`(object_id IS NOT NULL)`),
	index("audit_event_subject_idx").using("btree", table.subjectCandidateUserId.asc().nullsLast().op("text_ops")).where(sql`(subject_candidate_user_id IS NOT NULL)`),
	check("audit_event_kind_check", sql`kind = ANY (ARRAY['admin_action'::text, 'data_access'::text, 'security'::text])`),
	check("audit_event_source_check", sql`source = ANY (ARRAY['panel'::text, 'scheduled_job'::text, 'site'::text])`),
	check("audit_event_check", sql`num_nonnulls(actor_staff_user_id, actor_candidate_user_id, actor_portal_user_id, actor_system) <= 1`),
]);

export const emailOutbox = pgTable("email_outbox", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "email_outbox_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	template: text().notNull(),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	membershipId: bigint("membership_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	contactMessageId: bigint("contact_message_id", { mode: "number" }),
	params: jsonb(),
	dedupeKey: text("dedupe_key"),
	status: text().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	sendAfter: timestamp("send_after", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("email_outbox_body_idx").using("btree", sql`COALESCE(sent_at, send_after)`).where(sql`((status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text, 'dropped'::text])) AND (params IS NOT NULL))`),
	index("email_outbox_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")).where(sql`(candidate_user_id IS NOT NULL)`),
	index("email_outbox_pending_idx").using("btree", table.sendAfter.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	index("email_outbox_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")).where(sql`(portal_user_id IS NOT NULL)`),
	index("email_outbox_record_idx").using("btree", sql`COALESCE(sent_at, send_after)`).where(sql`(status = ANY (ARRAY['sending'::text, 'sent'::text, 'failed'::text, 'dropped'::text]))`),
	unique("email_outbox_dedupe_key_key").on(table.dedupeKey),
	check("email_outbox_status_check", sql`status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'dropped'::text])`),
	check("email_outbox_check", sql`num_nonnulls(candidate_user_id, portal_user_id, staff_user_id, membership_id, contact_message_id) = 1`),
]);

export const reviewItem = pgTable("review_item", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "review_item_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	queue: text().notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationNameId: bigint("organisation_name_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	payFloorId: bigint("pay_floor_id", { mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	contactMessageId: bigint("contact_message_id", { mode: "number" }),
	reason: text(),
	detail: jsonb(),
	claimedByStaffUserId: text("claimed_by_staff_user_id"),
	claimedAt: timestamp("claimed_at", { withTimezone: true, mode: 'string' }),
	status: text().default('open').notNull(),
	decidedByStaffUserId: text("decided_by_staff_user_id"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	outcome: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("review_item_candidate_idx").using("btree", table.candidateUserId.asc().nullsLast().op("text_ops")),
	uniqueIndex("review_item_candidate_unique").using("btree", table.queue.asc().nullsLast().op("text_ops"), table.candidateUserId.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_claimed_idx").using("btree", table.claimedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("review_item_contact_idx").using("btree", table.contactMessageId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("review_item_contact_unique").using("btree", table.queue.asc().nullsLast().op("text_ops"), table.contactMessageId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_decided_idx").using("btree", table.decidedByStaffUserId.asc().nullsLast().op("text_ops")),
	index("review_item_done_idx").using("btree", sql`COALESCE(decided_at, created_at)`).where(sql`(status = ANY (ARRAY['done'::text, 'dropped'::text]))`),
	index("review_item_floor_idx").using("btree", table.payFloorId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("review_item_floor_unique").using("btree", table.queue.asc().nullsLast().op("int8_ops"), table.payFloorId.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("review_item_job_unique").using("btree", table.queue.asc().nullsLast().op("int8_ops"), table.jobId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_name_idx").using("btree", table.organisationNameId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("review_item_name_unique").using("btree", table.queue.asc().nullsLast().op("int8_ops"), table.organisationNameId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	uniqueIndex("review_item_org_unique").using("btree", table.queue.asc().nullsLast().op("int8_ops"), table.organisationId.asc().nullsLast().op("int8_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_portal_idx").using("btree", table.portalUserId.asc().nullsLast().op("text_ops")),
	uniqueIndex("review_item_portal_unique").using("btree", table.queue.asc().nullsLast().op("text_ops"), table.portalUserId.asc().nullsLast().op("text_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	index("review_item_queue_idx").using("btree", table.queue.asc().nullsLast().op("timestamptz_ops"), table.createdAt.asc().nullsLast().op("text_ops"), table.id.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = ANY (ARRAY['open'::text, 'claimed'::text]))`),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "review_item_job_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "review_item_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationNameId],
			foreignColumns: [organisationName.id],
			name: "review_item_organisation_name_id_fkey"
		}),
	foreignKey({
			columns: [table.payFloorId],
			foreignColumns: [payFloor.id],
			name: "review_item_pay_floor_id_fkey"
		}),
	foreignKey({
			columns: [table.candidateUserId],
			foreignColumns: [candidateUser.id],
			name: "review_item_candidate_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.portalUserId],
			foreignColumns: [portalUser.id],
			name: "review_item_portal_user_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.contactMessageId],
			foreignColumns: [contactMessage.id],
			name: "review_item_contact_message_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.claimedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "review_item_claimed_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.decidedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "review_item_decided_by_staff_user_id_fkey"
		}),
	check("review_item_queue_check", sql`queue = ANY (ARRAY['fetched_job'::text, 'account_review'::text, 'pay_floor_check'::text, 'post_strike_job_review'::text, 'scam_flag'::text, 'agency_client_check'::text, 'data_request'::text, 'scheduled_check'::text])`),
	check("review_item_status_check", sql`status = ANY (ARRAY['open'::text, 'claimed'::text, 'done'::text, 'dropped'::text])`),
	check("review_item_check", sql`(status = ANY (ARRAY['done'::text, 'dropped'::text])) OR (
CASE
    WHEN (queue = 'scheduled_check'::text) THEN 0
    ELSE 1
END = num_nonnulls(job_id, organisation_id, organisation_name_id, pay_floor_id, candidate_user_id, portal_user_id, contact_message_id))`),
	check("review_item_check1", sql`(queue <> 'data_request'::text) OR (status <> ALL (ARRAY['done'::text, 'dropped'::text])) OR (num_nonnulls(candidate_user_id, portal_user_id) = 0)`),
]);
export const candidateServicesCase = pgView("candidate_services_case", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	requesterErasedAt: timestamp("requester_erased_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	permitType: text("permit_type"),
	offerDetails: jsonb("offer_details"),
	payer: text(),
	status: text(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closeReason: text("close_reason"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentRecordId: bigint("consent_record_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	employerContactConsentRecordId: bigint("employer_contact_consent_record_id", { mode: "number" }),
	assignedStaffUserId: text("assigned_staff_user_id"),
	dedupeKey: text("dedupe_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, requester_erased_at, organisation_id, job_id, permit_type, offer_details, payer, status, decided_at, closed_at, close_reason, consent_record_id, employer_contact_consent_record_id, assigned_staff_user_id, dedupe_key, created_at FROM services_case WHERE candidate_user_id IS NOT NULL`);

export const portalServicesCase = pgView("portal_services_case", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	requesterErasedAt: timestamp("requester_erased_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	permitType: text("permit_type"),
	offerDetails: jsonb("offer_details"),
	payer: text(),
	status: text(),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
	closeReason: text("close_reason"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentRecordId: bigint("consent_record_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	employerContactConsentRecordId: bigint("employer_contact_consent_record_id", { mode: "number" }),
	assignedStaffUserId: text("assigned_staff_user_id"),
	dedupeKey: text("dedupe_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, requester_erased_at, organisation_id, job_id, permit_type, offer_details, payer, status, decided_at, closed_at, close_reason, consent_record_id, employer_contact_consent_record_id, assigned_staff_user_id, dedupe_key, created_at FROM services_case WHERE portal_user_id IS NOT NULL`);

export const candidateCaseDocument = pgView("candidate_case_document", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	servicesCaseId: bigint("services_case_id", { mode: "number" }),
	storageKey: text("storage_key"),
	fileName: text("file_name"),
	contentType: text("content_type"),
	byteSize: integer("byte_size"),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }),
	copyDeletedAt: timestamp("copy_deleted_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id, portal_user_id, staff_user_id, uploaded_at, copy_deleted_at FROM case_document WHERE candidate_user_id IS NOT NULL`);

export const portalCaseDocument = pgView("portal_case_document", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	servicesCaseId: bigint("services_case_id", { mode: "number" }),
	storageKey: text("storage_key"),
	fileName: text("file_name"),
	contentType: text("content_type"),
	byteSize: integer("byte_size"),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }),
	copyDeletedAt: timestamp("copy_deleted_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, services_case_id, storage_key, file_name, content_type, byte_size, candidate_user_id, portal_user_id, staff_user_id, uploaded_at, copy_deleted_at FROM case_document WHERE portal_user_id IS NOT NULL`);

export const publishedContentPage = pgView("published_content_page", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	kind: text(),
	slug: text(),
	title: text(),
	body: text(),
	sourceUrl: text("source_url"),
	checkedOn: date("checked_on"),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, kind, slug, title, body, source_url, checked_on, published_at, updated_at FROM content_page WHERE status = 'published'::text`);

export const candidateConsentRecord = pgView("candidate_consent_record", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentTextId: bigint("consent_text_id", { mode: "number" }),
	givenAt: timestamp("given_at", { withTimezone: true, mode: 'string' }),
	withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	details: jsonb(),
	subjectErasedAt: timestamp("subject_erased_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, consent_text_id, given_at, withdrawn_at, job_id, organisation_id, details, subject_erased_at FROM consent_record WHERE candidate_user_id IS NOT NULL`);

export const portalConsentRecord = pgView("portal_consent_record", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	consentTextId: bigint("consent_text_id", { mode: "number" }),
	givenAt: timestamp("given_at", { withTimezone: true, mode: 'string' }),
	withdrawnAt: timestamp("withdrawn_at", { withTimezone: true, mode: 'string' }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	details: jsonb(),
	subjectErasedAt: timestamp("subject_erased_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, consent_text_id, given_at, withdrawn_at, job_id, organisation_id, details, subject_erased_at FROM consent_record WHERE portal_user_id IS NOT NULL`);

export const candidateNotificationPreference = pgView("candidate_notification_preference", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	category: text(),
	channel: text(),
	enabled: boolean(),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, staff_user_id, category, channel, enabled FROM notification_preference WHERE candidate_user_id IS NOT NULL`);

export const portalNotificationPreference = pgView("portal_notification_preference", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	staffUserId: text("staff_user_id"),
	category: text(),
	channel: text(),
	enabled: boolean(),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, staff_user_id, category, channel, enabled FROM notification_preference WHERE portal_user_id IS NOT NULL`);

export const candidateNotification = pgView("candidate_notification", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	category: text(),
	templateKey: text("template_key"),
	params: jsonb(),
	dedupeKey: text("dedupe_key"),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, organisation_id, category, template_key, params, dedupe_key, read_at, created_at FROM notification WHERE candidate_user_id IS NOT NULL`);

export const portalNotification = pgView("portal_notification", {	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }),
	candidateUserId: text("candidate_user_id"),
	portalUserId: text("portal_user_id"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }),
	category: text(),
	templateKey: text("template_key"),
	params: jsonb(),
	dedupeKey: text("dedupe_key"),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }),
}).with({"securityBarrier":true,"checkOption":"cascaded"}).as(sql`SELECT id, candidate_user_id, portal_user_id, organisation_id, category, template_key, params, dedupe_key, read_at, created_at FROM notification WHERE portal_user_id IS NOT NULL`);

// 0021, added by hand from the db:pull output to keep the diff small (a full pull reorders the file); the next full pull places it.
export const rulesVersion = pgTable("rules_version", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "rules_version_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	kind: text().notNull(),
	data: jsonb().notNull(),
	effectiveFrom: date("effective_from").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	approvalRequestId: bigint("approval_request_id", { mode: "number" }),
	proposedByStaffUserId: text("proposed_by_staff_user_id"),
	seededByOwner: boolean("seeded_by_owner").default(false).notNull(),
	runAt: timestamp("run_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("rules_version_in_force_idx").using("btree", table.kind.asc().nullsLast().op("date_ops"), table.effectiveFrom.desc().nullsFirst().op("int8_ops"), table.id.desc().nullsFirst().op("text_ops")),
	uniqueIndex("rules_version_one_seed").using("btree", table.kind.asc().nullsLast().op("text_ops")).where(sql`seeded_by_owner`),
	index("rules_version_proposed_idx").using("btree", table.proposedByStaffUserId.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.approvalRequestId],
			foreignColumns: [approvalRequest.id],
			name: "rules_version_approval_request_id_fkey"
		}),
	foreignKey({
			columns: [table.proposedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "rules_version_proposed_by_staff_user_id_fkey"
		}),
	unique("rules_version_approval_request_id_key").on(table.approvalRequestId),
	check("rules_version_check", sql`seeded_by_owner OR (approval_request_id IS NOT NULL)`),
	check("rules_version_data_check", sql`jsonb_typeof(data) = ANY (ARRAY['object'::text, 'array'::text])`),
	check("rules_version_kind_check", sql`kind = ANY (ARRAY['minimums'::text, 'critical_skills_list'::text, 'ineligible_list'::text, 'public_pay_employers'::text, 'big_company_names'::text])`),
]);

export const ownerReassign = pgTable("owner_reassign", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "owner_reassign_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	newOwnerMembershipId: bigint("new_owner_membership_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	oldOwnerMembershipId: bigint("old_owner_membership_id", { mode: "number" }).notNull(),
	domainChecked: boolean("domain_checked").notNull(),
	croChecked: boolean("cro_checked").notNull(),
	requestedByStaffUserId: text("requested_by_staff_user_id").notNull(),
	requestedAt: timestamp("requested_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completesAfter: timestamp("completes_after", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('open').notNull(),
	decidedByStaffUserId: text("decided_by_staff_user_id"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("owner_reassign_one_open").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")).where(sql`(status = 'open'::text)`),
	foreignKey({
			columns: [table.decidedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "owner_reassign_decided_by_staff_user_id_fkey"
		}),
	foreignKey({
			columns: [table.newOwnerMembershipId],
			foreignColumns: [membership.id],
			name: "owner_reassign_new_owner_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.oldOwnerMembershipId],
			foreignColumns: [membership.id],
			name: "owner_reassign_old_owner_membership_id_fkey"
		}),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "owner_reassign_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.requestedByStaffUserId],
			foreignColumns: [staffUser.id],
			name: "owner_reassign_requested_by_staff_user_id_fkey"
		}),
	check("owner_reassign_check", sql`domain_checked AND cro_checked`),
	check("owner_reassign_check1", sql`new_owner_membership_id <> old_owner_membership_id`),
	check("owner_reassign_check2", sql`completes_after >= (requested_at + '7 days'::interval)`),
	check("owner_reassign_check3", sql`(status = 'open'::text) = ((decided_by_staff_user_id IS NULL) AND (decided_at IS NULL))`),
	check("owner_reassign_status_check", sql`status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])`),
]);

export const jobAuthorityDocument = pgTable("job_authority_document", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "job_authority_document_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	jobId: bigint("job_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	organisationId: bigint("organisation_id", { mode: "number" }).notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	uploadedByMembershipId: bigint("uploaded_by_membership_id", { mode: "number" }),
	storageKey: text("storage_key"),
	fileName: text("file_name"),
	contentType: text("content_type"),
	byteSize: integer("byte_size"),
	uploadedAt: timestamp("uploaded_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	copyDeletedAt: timestamp("copy_deleted_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("job_authority_document_job_idx").using("btree", table.jobId.asc().nullsLast().op("int8_ops")),
	index("job_authority_document_member_idx").using("btree", table.uploadedByMembershipId.asc().nullsLast().op("int8_ops")),
	index("job_authority_document_org_idx").using("btree", table.organisationId.asc().nullsLast().op("int8_ops")),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [job.id],
			name: "job_authority_document_job_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organisationId],
			foreignColumns: [organisation.id],
			name: "job_authority_document_organisation_id_fkey"
		}),
	foreignKey({
			columns: [table.uploadedByMembershipId],
			foreignColumns: [membership.id],
			name: "job_authority_document_uploaded_by_membership_id_fkey"
		}),
	check("job_authority_document_check", sql`(storage_key IS NULL) = (copy_deleted_at IS NOT NULL)`),
]);
