// Made by npm run db:pull (packages/db/test/pull-schema.mjs) from a database built by packages/db/migrations.
// Do not edit by hand: change a migration, then run npm run db:pull. schema.test.ts fails until the two match.
import { relations } from "drizzle-orm/relations";
import { job, application, candidateUser, consentRecord, organisation, contactRequest, membership, candidateHiddenOrganisation, message, jobSource, fetchedAdvert, payFloor, organisationName, staffUser, report, jobText, fetchRun, jobDailyStat, candidateAccount, candidateSession, candidateProfile, candidateCv, savedJob, trackerEntry, applyClick, alert, portalUser, portalAccount, portalSession, organisationDomain, detePermitCount, sponsorshipStatement, consentText, approvalRequest, staffSession, staffAccount, staffRole, servicesCase, caseNote, caseDocument, caseQuote, contentPage, contactMessage, strike, ban, notificationPreference, notification, setting, reviewItem } from "./schema";

export const applicationRelations = relations(application, ({one, many}) => ({
	job: one(job, {
		fields: [application.jobId],
		references: [job.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [application.candidateUserId],
		references: [candidateUser.id]
	}),
	consentRecord: one(consentRecord, {
		fields: [application.consentRecordId],
		references: [consentRecord.id]
	}),
	messages: many(message),
	trackerEntries: many(trackerEntry),
}));

export const jobRelations = relations(job, ({one, many}) => ({
	applications: many(application),
	organisation: one(organisation, {
		fields: [job.organisationId],
		references: [organisation.id]
	}),
	jobSource: one(jobSource, {
		fields: [job.jobSourceId],
		references: [jobSource.id]
	}),
	fetchedAdvert: one(fetchedAdvert, {
		fields: [job.fetchedAdvertId],
		references: [fetchedAdvert.id]
	}),
	payFloor: one(payFloor, {
		fields: [job.payFloorId],
		references: [payFloor.id]
	}),
	organisationName: one(organisationName, {
		fields: [job.permitEmployerNameId],
		references: [organisationName.id]
	}),
	staffUser: one(staffUser, {
		fields: [job.postedByStaffId],
		references: [staffUser.id]
	}),
	membership_hireAnsweredByMembershipId: one(membership, {
		fields: [job.hireAnsweredByMembershipId],
		references: [membership.id],
		relationName: "job_hireAnsweredByMembershipId_membership_id"
	}),
	membership_organisationId: one(membership, {
		fields: [job.organisationId],
		references: [membership.id],
		relationName: "job_organisationId_membership_id"
	}),
	report: one(report, {
		fields: [job.hiddenReportId],
		references: [report.id],
		relationName: "job_hiddenReportId_report_id"
	}),
	jobTexts: many(jobText),
	jobDailyStats: many(jobDailyStat),
	savedJobs: many(savedJob),
	trackerEntries: many(trackerEntry),
	applyClicks: many(applyClick),
	sponsorshipStatements: many(sponsorshipStatement),
	servicesCases: many(servicesCase),
	reports: many(report, {
		relationName: "report_targetJobId_job_id"
	}),
	strikes: many(strike),
	consentRecords: many(consentRecord),
	reviewItems: many(reviewItem),
}));

export const candidateUserRelations = relations(candidateUser, ({many}) => ({
	applications: many(application),
	contactRequests: many(contactRequest),
	candidateHiddenOrganisations: many(candidateHiddenOrganisation),
	messages: many(message),
	candidateAccounts: many(candidateAccount),
	candidateSessions: many(candidateSession),
	candidateProfiles: many(candidateProfile),
	candidateCvs: many(candidateCv),
	savedJobs: many(savedJob),
	trackerEntries: many(trackerEntry),
	applyClicks: many(applyClick),
	alerts: many(alert),
	servicesCases: many(servicesCase),
	caseDocuments: many(caseDocument),
	contactMessages: many(contactMessage),
	reports_targetCandidateUserId: many(report, {
		relationName: "report_targetCandidateUserId_candidateUser_id"
	}),
	reports_reporterCandidateUserId: many(report, {
		relationName: "report_reporterCandidateUserId_candidateUser_id"
	}),
	consentRecords: many(consentRecord),
	notificationPreferences: many(notificationPreference),
	notifications: many(notification),
	reviewItems: many(reviewItem),
}));

export const consentRecordRelations = relations(consentRecord, ({one, many}) => ({
	applications: many(application),
	contactRequests: many(contactRequest),
	servicesCases_consentRecordId: many(servicesCase, {
		relationName: "servicesCase_consentRecordId_consentRecord_id"
	}),
	servicesCases_employerContactConsentRecordId: many(servicesCase, {
		relationName: "servicesCase_employerContactConsentRecordId_consentRecord_id"
	}),
	candidateUser: one(candidateUser, {
		fields: [consentRecord.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [consentRecord.portalUserId],
		references: [portalUser.id]
	}),
	consentText: one(consentText, {
		fields: [consentRecord.consentTextId],
		references: [consentText.id]
	}),
	job: one(job, {
		fields: [consentRecord.jobId],
		references: [job.id]
	}),
	organisation: one(organisation, {
		fields: [consentRecord.organisationId],
		references: [organisation.id]
	}),
}));

export const contactRequestRelations = relations(contactRequest, ({one, many}) => ({
	organisation: one(organisation, {
		fields: [contactRequest.organisationId],
		references: [organisation.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [contactRequest.candidateUserId],
		references: [candidateUser.id]
	}),
	consentRecord: one(consentRecord, {
		fields: [contactRequest.consentRecordId],
		references: [consentRecord.id]
	}),
	membership: one(membership, {
		fields: [contactRequest.organisationId],
		references: [membership.id]
	}),
	messages: many(message),
}));

export const organisationRelations = relations(organisation, ({one, many}) => ({
	contactRequests: many(contactRequest),
	candidateHiddenOrganisations: many(candidateHiddenOrganisation),
	jobs: many(job),
	organisation: one(organisation, {
		fields: [organisation.mergedIntoId],
		references: [organisation.id],
		relationName: "organisation_mergedIntoId_organisation_id"
	}),
	organisations: many(organisation, {
		relationName: "organisation_mergedIntoId_organisation_id"
	}),
	organisationNames: many(organisationName),
	organisationDomains: many(organisationDomain),
	memberships: many(membership),
	sponsorshipStatements: many(sponsorshipStatement),
	payFloors: many(payFloor),
	servicesCases: many(servicesCase),
	caseQuotes: many(caseQuote),
	reports: many(report),
	strikes: many(strike),
	consentRecords: many(consentRecord),
	notifications: many(notification),
	reviewItems: many(reviewItem),
}));

export const membershipRelations = relations(membership, ({one, many}) => ({
	contactRequests: many(contactRequest),
	messages: many(message),
	jobs_hireAnsweredByMembershipId: many(job, {
		relationName: "job_hireAnsweredByMembershipId_membership_id"
	}),
	jobs_organisationId: many(job, {
		relationName: "job_organisationId_membership_id"
	}),
	organisation: one(organisation, {
		fields: [membership.organisationId],
		references: [organisation.id]
	}),
	portalUser: one(portalUser, {
		fields: [membership.portalUserId],
		references: [portalUser.id]
	}),
	membership: one(membership, {
		fields: [membership.invitedByMembershipId],
		references: [membership.id],
		relationName: "membership_invitedByMembershipId_membership_id"
	}),
	memberships: many(membership, {
		relationName: "membership_invitedByMembershipId_membership_id"
	}),
	sponsorshipStatements: many(sponsorshipStatement),
	payFloors: many(payFloor),
}));

export const candidateHiddenOrganisationRelations = relations(candidateHiddenOrganisation, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [candidateHiddenOrganisation.candidateUserId],
		references: [candidateUser.id]
	}),
	organisation: one(organisation, {
		fields: [candidateHiddenOrganisation.organisationId],
		references: [organisation.id]
	}),
}));

export const messageRelations = relations(message, ({one, many}) => ({
	application: one(application, {
		fields: [message.applicationId],
		references: [application.id]
	}),
	contactRequest: one(contactRequest, {
		fields: [message.contactRequestId],
		references: [contactRequest.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [message.senderCandidateUserId],
		references: [candidateUser.id]
	}),
	membership: one(membership, {
		fields: [message.senderMembershipId],
		references: [membership.id]
	}),
	reports: many(report),
}));

export const jobSourceRelations = relations(jobSource, ({many}) => ({
	jobs: many(job),
	fetchedAdverts: many(fetchedAdvert),
	fetchRuns: many(fetchRun),
}));

export const fetchedAdvertRelations = relations(fetchedAdvert, ({one, many}) => ({
	jobs: many(job),
	jobSource: one(jobSource, {
		fields: [fetchedAdvert.jobSourceId],
		references: [jobSource.id]
	}),
}));

export const payFloorRelations = relations(payFloor, ({one, many}) => ({
	jobs: many(job),
	organisation: one(organisation, {
		fields: [payFloor.organisationId],
		references: [organisation.id]
	}),
	consentText: one(consentText, {
		fields: [payFloor.consentTextId],
		references: [consentText.id]
	}),
	staffUser: one(staffUser, {
		fields: [payFloor.checkedByStaffId],
		references: [staffUser.id]
	}),
	approvalRequest: one(approvalRequest, {
		fields: [payFloor.approvalRequestId],
		references: [approvalRequest.id]
	}),
	payFloor: one(payFloor, {
		fields: [payFloor.replacesId],
		references: [payFloor.id],
		relationName: "payFloor_replacesId_payFloor_id"
	}),
	payFloors: many(payFloor, {
		relationName: "payFloor_replacesId_payFloor_id"
	}),
	membership: one(membership, {
		fields: [payFloor.organisationId],
		references: [membership.id]
	}),
	strikes: many(strike),
	reviewItems: many(reviewItem),
}));

export const organisationNameRelations = relations(organisationName, ({one, many}) => ({
	jobs: many(job),
	organisation: one(organisation, {
		fields: [organisationName.organisationId],
		references: [organisation.id]
	}),
	staffUser: one(staffUser, {
		fields: [organisationName.confirmedByStaffId],
		references: [staffUser.id]
	}),
	detePermitCounts: many(detePermitCount),
	reviewItems: many(reviewItem),
}));

export const staffUserRelations = relations(staffUser, ({many}) => ({
	jobs: many(job),
	organisationNames: many(organisationName),
	organisationDomains: many(organisationDomain),
	sponsorshipStatements: many(sponsorshipStatement),
	payFloors: many(payFloor),
	staffSessions: many(staffSession),
	staffAccounts: many(staffAccount),
	staffRoles_staffUserId: many(staffRole, {
		relationName: "staffRole_staffUserId_staffUser_id"
	}),
	staffRoles_grantedByStaffUserId: many(staffRole, {
		relationName: "staffRole_grantedByStaffUserId_staffUser_id"
	}),
	servicesCases: many(servicesCase),
	caseNotes: many(caseNote),
	caseDocuments: many(caseDocument),
	caseQuotes: many(caseQuote),
	contentPages: many(contentPage),
	contactMessages: many(contactMessage),
	reports: many(report),
	strikes_replyEnteredByStaffUserId: many(strike, {
		relationName: "strike_replyEnteredByStaffUserId_staffUser_id"
	}),
	strikes_decidedByStaffUserId: many(strike, {
		relationName: "strike_decidedByStaffUserId_staffUser_id"
	}),
	strikes_appealEnteredByStaffUserId: many(strike, {
		relationName: "strike_appealEnteredByStaffUserId_staffUser_id"
	}),
	strikes_appealDecidedByStaffUserId: many(strike, {
		relationName: "strike_appealDecidedByStaffUserId_staffUser_id"
	}),
	notificationPreferences: many(notificationPreference),
	approvalRequests_proposedByStaffUserId: many(approvalRequest, {
		relationName: "approvalRequest_proposedByStaffUserId_staffUser_id"
	}),
	approvalRequests_confirmedByStaffUserId: many(approvalRequest, {
		relationName: "approvalRequest_confirmedByStaffUserId_staffUser_id"
	}),
	settings: many(setting),
	reviewItems_claimedByStaffUserId: many(reviewItem, {
		relationName: "reviewItem_claimedByStaffUserId_staffUser_id"
	}),
	reviewItems_decidedByStaffUserId: many(reviewItem, {
		relationName: "reviewItem_decidedByStaffUserId_staffUser_id"
	}),
}));

export const reportRelations = relations(report, ({one, many}) => ({
	jobs: many(job, {
		relationName: "job_hiddenReportId_report_id"
	}),
	job: one(job, {
		fields: [report.targetJobId],
		references: [job.id],
		relationName: "report_targetJobId_job_id"
	}),
	organisation: one(organisation, {
		fields: [report.targetOrganisationId],
		references: [organisation.id]
	}),
	message: one(message, {
		fields: [report.targetMessageId],
		references: [message.id]
	}),
	candidateUser_targetCandidateUserId: one(candidateUser, {
		fields: [report.targetCandidateUserId],
		references: [candidateUser.id],
		relationName: "report_targetCandidateUserId_candidateUser_id"
	}),
	candidateUser_reporterCandidateUserId: one(candidateUser, {
		fields: [report.reporterCandidateUserId],
		references: [candidateUser.id],
		relationName: "report_reporterCandidateUserId_candidateUser_id"
	}),
	portalUser: one(portalUser, {
		fields: [report.reporterPortalUserId],
		references: [portalUser.id]
	}),
	staffUser: one(staffUser, {
		fields: [report.decidedByStaffUserId],
		references: [staffUser.id]
	}),
	strikes: many(strike),
}));

export const jobTextRelations = relations(jobText, ({one}) => ({
	job: one(job, {
		fields: [jobText.jobId],
		references: [job.id]
	}),
}));

export const fetchRunRelations = relations(fetchRun, ({one}) => ({
	jobSource: one(jobSource, {
		fields: [fetchRun.jobSourceId],
		references: [jobSource.id]
	}),
}));

export const jobDailyStatRelations = relations(jobDailyStat, ({one}) => ({
	job: one(job, {
		fields: [jobDailyStat.jobId],
		references: [job.id]
	}),
}));

export const candidateAccountRelations = relations(candidateAccount, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [candidateAccount.userId],
		references: [candidateUser.id]
	}),
}));

export const candidateSessionRelations = relations(candidateSession, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [candidateSession.userId],
		references: [candidateUser.id]
	}),
}));

export const candidateProfileRelations = relations(candidateProfile, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [candidateProfile.candidateUserId],
		references: [candidateUser.id]
	}),
}));

export const candidateCvRelations = relations(candidateCv, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [candidateCv.candidateUserId],
		references: [candidateUser.id]
	}),
}));

export const savedJobRelations = relations(savedJob, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [savedJob.candidateUserId],
		references: [candidateUser.id]
	}),
	job: one(job, {
		fields: [savedJob.jobId],
		references: [job.id]
	}),
}));

export const trackerEntryRelations = relations(trackerEntry, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [trackerEntry.candidateUserId],
		references: [candidateUser.id]
	}),
	job: one(job, {
		fields: [trackerEntry.jobId],
		references: [job.id]
	}),
	application: one(application, {
		fields: [trackerEntry.applicationId],
		references: [application.id]
	}),
}));

export const applyClickRelations = relations(applyClick, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [applyClick.candidateUserId],
		references: [candidateUser.id]
	}),
	job: one(job, {
		fields: [applyClick.jobId],
		references: [job.id]
	}),
}));

export const alertRelations = relations(alert, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [alert.candidateUserId],
		references: [candidateUser.id]
	}),
}));

export const portalAccountRelations = relations(portalAccount, ({one}) => ({
	portalUser: one(portalUser, {
		fields: [portalAccount.userId],
		references: [portalUser.id]
	}),
}));

export const portalUserRelations = relations(portalUser, ({many}) => ({
	portalAccounts: many(portalAccount),
	portalSessions: many(portalSession),
	memberships: many(membership),
	servicesCases: many(servicesCase),
	caseDocuments: many(caseDocument),
	contactMessages: many(contactMessage),
	reports: many(report),
	consentRecords: many(consentRecord),
	notificationPreferences: many(notificationPreference),
	notifications: many(notification),
	reviewItems: many(reviewItem),
}));

export const portalSessionRelations = relations(portalSession, ({one}) => ({
	portalUser: one(portalUser, {
		fields: [portalSession.userId],
		references: [portalUser.id]
	}),
}));

export const organisationDomainRelations = relations(organisationDomain, ({one}) => ({
	organisation: one(organisation, {
		fields: [organisationDomain.organisationId],
		references: [organisation.id]
	}),
	staffUser: one(staffUser, {
		fields: [organisationDomain.addedByStaffId],
		references: [staffUser.id]
	}),
}));

export const detePermitCountRelations = relations(detePermitCount, ({one}) => ({
	organisationName: one(organisationName, {
		fields: [detePermitCount.organisationNameId],
		references: [organisationName.id]
	}),
}));

export const sponsorshipStatementRelations = relations(sponsorshipStatement, ({one}) => ({
	job: one(job, {
		fields: [sponsorshipStatement.jobId],
		references: [job.id]
	}),
	organisation: one(organisation, {
		fields: [sponsorshipStatement.organisationId],
		references: [organisation.id]
	}),
	consentText: one(consentText, {
		fields: [sponsorshipStatement.consentTextId],
		references: [consentText.id]
	}),
	staffUser: one(staffUser, {
		fields: [sponsorshipStatement.enteredByStaffId],
		references: [staffUser.id]
	}),
	approvalRequest: one(approvalRequest, {
		fields: [sponsorshipStatement.approvalRequestId],
		references: [approvalRequest.id]
	}),
	membership: one(membership, {
		fields: [sponsorshipStatement.organisationId],
		references: [membership.id]
	}),
}));

export const consentTextRelations = relations(consentText, ({one, many}) => ({
	sponsorshipStatements: many(sponsorshipStatement),
	payFloors: many(payFloor),
	approvalRequest: one(approvalRequest, {
		fields: [consentText.approvalRequestId],
		references: [approvalRequest.id]
	}),
	consentRecords: many(consentRecord),
}));

export const approvalRequestRelations = relations(approvalRequest, ({one, many}) => ({
	sponsorshipStatements: many(sponsorshipStatement),
	payFloors: many(payFloor),
	staffRoles: many(staffRole),
	strikes: many(strike),
	bans: many(ban),
	consentTexts: many(consentText),
	staffUser_proposedByStaffUserId: one(staffUser, {
		fields: [approvalRequest.proposedByStaffUserId],
		references: [staffUser.id],
		relationName: "approvalRequest_proposedByStaffUserId_staffUser_id"
	}),
	staffUser_confirmedByStaffUserId: one(staffUser, {
		fields: [approvalRequest.confirmedByStaffUserId],
		references: [staffUser.id],
		relationName: "approvalRequest_confirmedByStaffUserId_staffUser_id"
	}),
}));

export const staffSessionRelations = relations(staffSession, ({one}) => ({
	staffUser: one(staffUser, {
		fields: [staffSession.userId],
		references: [staffUser.id]
	}),
}));

export const staffAccountRelations = relations(staffAccount, ({one}) => ({
	staffUser: one(staffUser, {
		fields: [staffAccount.userId],
		references: [staffUser.id]
	}),
}));

export const staffRoleRelations = relations(staffRole, ({one}) => ({
	staffUser_staffUserId: one(staffUser, {
		fields: [staffRole.staffUserId],
		references: [staffUser.id],
		relationName: "staffRole_staffUserId_staffUser_id"
	}),
	staffUser_grantedByStaffUserId: one(staffUser, {
		fields: [staffRole.grantedByStaffUserId],
		references: [staffUser.id],
		relationName: "staffRole_grantedByStaffUserId_staffUser_id"
	}),
	approvalRequest: one(approvalRequest, {
		fields: [staffRole.approvalRequestId],
		references: [approvalRequest.id]
	}),
}));

export const servicesCaseRelations = relations(servicesCase, ({one, many}) => ({
	candidateUser: one(candidateUser, {
		fields: [servicesCase.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [servicesCase.portalUserId],
		references: [portalUser.id]
	}),
	organisation: one(organisation, {
		fields: [servicesCase.organisationId],
		references: [organisation.id]
	}),
	job: one(job, {
		fields: [servicesCase.jobId],
		references: [job.id]
	}),
	consentRecord_consentRecordId: one(consentRecord, {
		fields: [servicesCase.consentRecordId],
		references: [consentRecord.id],
		relationName: "servicesCase_consentRecordId_consentRecord_id"
	}),
	consentRecord_employerContactConsentRecordId: one(consentRecord, {
		fields: [servicesCase.employerContactConsentRecordId],
		references: [consentRecord.id],
		relationName: "servicesCase_employerContactConsentRecordId_consentRecord_id"
	}),
	staffUser: one(staffUser, {
		fields: [servicesCase.assignedStaffUserId],
		references: [staffUser.id]
	}),
	caseNotes: many(caseNote),
	caseDocuments: many(caseDocument),
	caseQuotes: many(caseQuote),
}));

export const caseNoteRelations = relations(caseNote, ({one}) => ({
	servicesCase: one(servicesCase, {
		fields: [caseNote.servicesCaseId],
		references: [servicesCase.id]
	}),
	staffUser: one(staffUser, {
		fields: [caseNote.authorStaffUserId],
		references: [staffUser.id]
	}),
}));

export const caseDocumentRelations = relations(caseDocument, ({one}) => ({
	servicesCase: one(servicesCase, {
		fields: [caseDocument.servicesCaseId],
		references: [servicesCase.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [caseDocument.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [caseDocument.portalUserId],
		references: [portalUser.id]
	}),
	staffUser: one(staffUser, {
		fields: [caseDocument.staffUserId],
		references: [staffUser.id]
	}),
}));

export const caseQuoteRelations = relations(caseQuote, ({one}) => ({
	servicesCase: one(servicesCase, {
		fields: [caseQuote.servicesCaseId],
		references: [servicesCase.id]
	}),
	organisation: one(organisation, {
		fields: [caseQuote.organisationId],
		references: [organisation.id]
	}),
	staffUser: one(staffUser, {
		fields: [caseQuote.quotedByStaffUserId],
		references: [staffUser.id]
	}),
}));

export const contentPageRelations = relations(contentPage, ({one}) => ({
	staffUser: one(staffUser, {
		fields: [contentPage.updatedByStaffUserId],
		references: [staffUser.id]
	}),
}));

export const contactMessageRelations = relations(contactMessage, ({one, many}) => ({
	portalUser: one(portalUser, {
		fields: [contactMessage.portalUserId],
		references: [portalUser.id]
	}),
	staffUser: one(staffUser, {
		fields: [contactMessage.claimedByStaffUserId],
		references: [staffUser.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [contactMessage.candidateUserId],
		references: [candidateUser.id]
	}),
	reviewItems: many(reviewItem),
}));

export const strikeRelations = relations(strike, ({one, many}) => ({
	job: one(job, {
		fields: [strike.jobId],
		references: [job.id]
	}),
	payFloor: one(payFloor, {
		fields: [strike.payFloorId],
		references: [payFloor.id]
	}),
	organisation: one(organisation, {
		fields: [strike.organisationId],
		references: [organisation.id]
	}),
	report: one(report, {
		fields: [strike.reportId],
		references: [report.id]
	}),
	staffUser_replyEnteredByStaffUserId: one(staffUser, {
		fields: [strike.replyEnteredByStaffUserId],
		references: [staffUser.id],
		relationName: "strike_replyEnteredByStaffUserId_staffUser_id"
	}),
	staffUser_decidedByStaffUserId: one(staffUser, {
		fields: [strike.decidedByStaffUserId],
		references: [staffUser.id],
		relationName: "strike_decidedByStaffUserId_staffUser_id"
	}),
	approvalRequest: one(approvalRequest, {
		fields: [strike.approvalRequestId],
		references: [approvalRequest.id]
	}),
	staffUser_appealEnteredByStaffUserId: one(staffUser, {
		fields: [strike.appealEnteredByStaffUserId],
		references: [staffUser.id],
		relationName: "strike_appealEnteredByStaffUserId_staffUser_id"
	}),
	staffUser_appealDecidedByStaffUserId: one(staffUser, {
		fields: [strike.appealDecidedByStaffUserId],
		references: [staffUser.id],
		relationName: "strike_appealDecidedByStaffUserId_staffUser_id"
	}),
	bans: many(ban),
}));

export const banRelations = relations(ban, ({one}) => ({
	strike: one(strike, {
		fields: [ban.strikeId],
		references: [strike.id]
	}),
	approvalRequest: one(approvalRequest, {
		fields: [ban.approvalRequestId],
		references: [approvalRequest.id]
	}),
}));

export const notificationPreferenceRelations = relations(notificationPreference, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [notificationPreference.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [notificationPreference.portalUserId],
		references: [portalUser.id]
	}),
	staffUser: one(staffUser, {
		fields: [notificationPreference.staffUserId],
		references: [staffUser.id]
	}),
}));

export const notificationRelations = relations(notification, ({one}) => ({
	candidateUser: one(candidateUser, {
		fields: [notification.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [notification.portalUserId],
		references: [portalUser.id]
	}),
	organisation: one(organisation, {
		fields: [notification.organisationId],
		references: [organisation.id]
	}),
}));

export const settingRelations = relations(setting, ({one}) => ({
	staffUser: one(staffUser, {
		fields: [setting.updatedByStaffUserId],
		references: [staffUser.id]
	}),
}));

export const reviewItemRelations = relations(reviewItem, ({one}) => ({
	job: one(job, {
		fields: [reviewItem.jobId],
		references: [job.id]
	}),
	organisation: one(organisation, {
		fields: [reviewItem.organisationId],
		references: [organisation.id]
	}),
	organisationName: one(organisationName, {
		fields: [reviewItem.organisationNameId],
		references: [organisationName.id]
	}),
	payFloor: one(payFloor, {
		fields: [reviewItem.payFloorId],
		references: [payFloor.id]
	}),
	candidateUser: one(candidateUser, {
		fields: [reviewItem.candidateUserId],
		references: [candidateUser.id]
	}),
	portalUser: one(portalUser, {
		fields: [reviewItem.portalUserId],
		references: [portalUser.id]
	}),
	contactMessage: one(contactMessage, {
		fields: [reviewItem.contactMessageId],
		references: [contactMessage.id]
	}),
	staffUser_claimedByStaffUserId: one(staffUser, {
		fields: [reviewItem.claimedByStaffUserId],
		references: [staffUser.id],
		relationName: "reviewItem_claimedByStaffUserId_staffUser_id"
	}),
	staffUser_decidedByStaffUserId: one(staffUser, {
		fields: [reviewItem.decidedByStaffUserId],
		references: [staffUser.id],
		relationName: "reviewItem_decidedByStaffUserId_staffUser_id"
	}),
}));
