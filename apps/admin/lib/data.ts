// The data layer of the admin pages (nextjs.org/docs/app/guides/data-security): a Server Component reads only through here, never through @portal/db or its own
// Route Handlers. Each read is the database function a route calls, run for the signed-in staff member: the session is read from the request's headers, a signed-out
// or disabled login throws StaffRefused (from @portal/auth) before any read, and the role checks stay in the database functions, so a page gets the same answer or
// refusal as the API. `server-only` is Next's own copy (aliased by its compilers): importing this file from a Client Component fails the build. Not in packages/db,
// which the CLIs and vitest load outside Next. The import wall test is data.test.ts.
import "server-only";
import { headers } from "next/headers";
import {
  type ApproveInput, dryRunApprove, getAccountReview, getContact, getContentPage, getFloorCheck, getItem, getJobQueueItem, getPool, getReport, getServiceCase, getCase, latestPermitRises, listAccountReviews, listAudit,
  listContact, listContentPages, listCases, listDomains, listFloorChecks, listJobQueue, listManualPosts, listOwnerReassigns, listQueue, listReports, listRules, listServiceCases,
  listSolicitors, listStaff, listStaleContent, previewCompanies, previewContentPage, signupNoCounts, staffMe, deteLinkSuggestions, searchStaff,
} from "@portal/db";
import {
  accuracySample, fetchedDecisions, listCandidateMerges, listCompanySeed, listDataRequests, listOverdue, listScheduledChecks, listSettings, myCounts, targetCounts,
} from "@portal/db/staff-tools";
import { listLegal } from "@portal/db/legal-texts";
import { queueRules } from "./queue-rules";
import { sidebarCounts } from "./sidebar";
import { requireStaff } from "./staff";

export type { ApproveInput, AuditFilter, AuditRow, DryRun } from "@portal/db";

type Pool = ReturnType<typeof getPool>;
/** A read run as the signed-in staff member: `fn(pool, staffId, ...args)`. */
const asStaff = <A extends unknown[], R>(fn: (db: Pool, staff: string, ...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => fn(getPool(), await requireStaff(await headers()), ...a);

// who is signed in, and the sidebar
export const readMe = asStaff(staffMe);
export const readCounts = asStaff(myCounts); // (options?) { merges: true } adds the name-merge suggestion count
/**
 * P4: what the sidebar shows: the signed-in staff member's name, roles and queue counts (staffMe and myCounts, as GET /api/staff/me and /me/counts), or null for a
 * visitor, a disabled login or any failure (the sign-in pages share the layout and show the bare page; every page and route still checks its own role).
 */
export async function readSidebar(): Promise<{ name: string; roles: string[]; counts: Record<string, number | undefined> } | null> {
  const h = await headers(); // outside the try: Next's own "dynamic page" signal while prerendering must not be swallowed (it would bake the signed-out frame into a static page)
  try {
    const staff = await requireStaff(h);
    const me = await staffMe(getPool(), staff);
    return { name: me.name, roles: me.roles, counts: sidebarCounts(await myCounts(getPool(), staff)) };
  } catch {
    return null;
  }
}

export const readSearch = asStaff(searchStaff); // (q) B58: the matches for the kinds the roles may search; bad_query for a text under 3 or over 100 characters

// lists and items of the review queues
export const readFetchedJobs = asStaff(listQueue);
export const readFetchedJob = asStaff(getItem);
export const readFetchedJobDryRun = asStaff(async (db: Pool, staff: string, id: string, input: ApproveInput) => dryRunApprove(db, staff, id, input, await queueRules(db))); // what Approve would do, nothing written
export const readFetchedDecisions = asStaff(fetchedDecisions);
export const readAccountReviews = asStaff(listAccountReviews);
export const readAccountReview = asStaff(getAccountReview);
export const readEmployerJobs = asStaff(listJobQueue); // (queue, options?)
export const readEmployerJob = asStaff(getJobQueueItem);
export const readFloorChecks = asStaff(listFloorChecks);
export const readFloorCheck = asStaff(getFloorCheck);
export const readManualPosts = asStaff(listManualPosts);
export const readReports = asStaff(listReports);
export const readReport = asStaff(getReport);
export const readStrikeCases = asStaff(listCases);
export const readStrikeCase = asStaff(getCase);
export const readContactMessages = asStaff(listContact);
export const readContactMessage = asStaff(getContact);
export const readServiceCases = asStaff(listServiceCases);
export const readServiceCase = asStaff(getServiceCase);
export const readSolicitors = asStaff(listSolicitors);
export const readDeteLinks = asStaff(deteLinkSuggestions); // (page)

// companies and accounts
export const readCompanyPreview = asStaff(previewCompanies); // (ids)
export const readCompanyDomains = asStaff(listDomains); // (organisationId)
export const readCompanySeed = asStaff(listCompanySeed);
export const readOwnerReassigns = asStaff(listOwnerReassigns);
export const readCandidateMerges = asStaff(listCandidateMerges);
export const readDataRequests = asStaff(listDataRequests);

// rules, settings, texts, content
export const readRules = asStaff(listRules);
export const readSettings = asStaff(listSettings);
export const readLegal = asStaff(listLegal);
export const readContentPages = asStaff(listContentPages);
export const readContentPage = asStaff(getContentPage);
export const readContentPreview = asStaff(previewContentPage);
export const readStaleContent = asStaff(listStaleContent); // (kind?) guides, help and occupation pages
export const readScheduledChecks = asStaff(listScheduledChecks);

// the team, the audit log, the numbers
export const readStaff = asStaff(listStaff);
export const readAudit = asStaff(listAudit); // (filter?) one page; the CSV is GET /api/audit/export
export const readOverdue = asStaff(listOverdue);
export const readTargets = asStaff(targetCounts);
export const readAccuracySample = asStaff(accuracySample);
export const readPermitRises = async () => (await requireStaff(await headers()), latestPermitRises(getPool()));
export const readSignupNoCounts = async () => (await requireStaff(await headers()), signupNoCounts(getPool()));
