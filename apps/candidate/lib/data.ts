// The data layer of the candidate pages (nextjs.org/docs/app/guides/data-security): a Server Component reads only through here, never through
// @portal/db or its own Route Handlers, so the visitor cap of 6 jobs and the read limit apply to a page as they do to the API (gatedRead).
// `server-only` is Next's own copy (aliased by its compilers): importing this file from a Client Component fails the build. Not in packages/db,
// which the CLIs and vitest load outside Next.
import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { connection } from "next/server";
import {
  dataRequestGet, checkerRead, companiesRead, closedJobRead, companyRead, countJobView, gatedRead, readGate, uncounted, getPool, getRules, guideRead, guidesRead, helpListRead, helpRead, jobRead, jobsRead, legalRead, minimumsRead, occupationRead, occupationsRead,
  permitNoticeRead, registrationBodiesRead, sectorsRead, similarRead, sitemapIds, sitemapIndexXml, sitemapPart, updatesRead, type Gate, type ReadResult, type SitemapEntry, type Work,
} from "@portal/db";
import { candidateSettings, googleSettings, sessionOnce } from "@portal/auth";
import { standingLine } from "@portal/rules";
import { alertsGet, unsubscribeGet } from "./alerts";
import { dataAccessGet, jobGet, noticesGet, profileGet, promptsGet, savedList, securityGet, settingsGet, trackerGet } from "./account";
import { caseList, caseRead, caseTimeline } from "./cases";
import { candidateAuth, signedInCandidate } from "./candidate";
import { cvRead, docsList } from "./files";

type Query = ConstructorParameters<typeof URLSearchParams>[0];
// PERF-3: one session lookup and one read-limit count per request, whatever the number of reads a render makes (the home page makes 6): React's
// cache keeps the first gate's answer for the rest of the request. It takes no argument, so nothing of the query (or the RSC header) can make a second count.
const requestGate = cache(async () => readGate(await headers(), signedInCandidate));
const sharedGate: Gate = () => requestGate();
const read = (work: Work, gate: Gate = sharedGate) => async (query?: Query): Promise<ReadResult> => gatedRead(await headers(), new URLSearchParams(query), signedInCandidate, work, gate);

export const readJobs = read(jobsRead);
export const readJob = read(jobRead);
export const readClosedJob = read(closedJobRead); // B27: ?id; { closed: true, reason, job, similar } for a closed or expired job, else 404. Call it when readJob answered 404
export const readSimilar = read(similarRead);
export const readCompany = read(companyRead);
export const readCompanies = read(companiesRead); // B25: the directory, ?q (a company or legal name), ?after; { companies, next }
export const readOccupation = read(occupationRead);
export const readHelp = read(helpRead);
export const readUpdates = read(updatesRead); // ?after, ?category (B17)
export const readChecker = read(checkerRead, uncounted); // PERF-3: reads no table (the rules are kept per instance), so not counted
export const readLegal = read(legalRead); // R5, B20: ?purpose=signup_terms, privacy_notice, cookie_policy, employer_acceptable_use or data_retention
export const readSectors = read(sectorsRead); // B1: the sectors with their live job counts
export const readGuide = read(guideRead); // B1: ?slug
export const readGuides = read(guidesRead); // B15: every guide, { slug, title, checkedOn }
export const readHelpList = read(helpListRead); // B19: every help page, { slug, title, category }
/** #291: the notice for the permit pages while DETE's portal is closed. `{ ok: true, data: null }` when staff have it off, so a page shows nothing. */
export const readPermitNotice = async (): Promise<ReadResult> => {
  const r = await read(permitNoticeRead)();
  return !r.ok && r.status === 404 ? { ok: true, data: null } : r;
};
export const readMinimums = read(minimumsRead); // B5: the minimums in force, no occupation
export const readOccupations = read(occupationsRead, uncounted); // B12: every code with title, slug and list status, for the pickers
export const readRegistrationBodies = read(registrationBodiesRead, uncounted); // B39: the profile's registration body dropdown
/** B40: which sign-in providers are on. Google only when both of its settings are set (off in production until G10), so a page hides its buttons otherwise. Reads no database. */
export const readSignInProviders = () => ({ google: googleSettings(process.env) !== undefined });

/** B1 (S12): counts one view of a job today; false when it is not live. Call it after readJob answered ok, which already counted the visit against the read limit. */
export const countView = (jobId: string) => countJobView(getPool(), jobId);

// B4: the signed-in candidate's own reads, through the same route functions the API serves (account.ts, alerts.ts, cases.ts, files.ts), so the
// session check and the answer are the route's. A refusal comes back as { ok: false, status, code } (401 NO_SESSION for a visitor), never thrown.
// Writes stay fetch calls to the route handlers.
async function mine(get: (r: Request) => Promise<Response>, query?: Query): Promise<ReadResult> {
  const url = new URL("/", siteOrigin());
  url.search = new URLSearchParams(query).toString();
  const res = await get(new Request(url, { headers: await headers() }));
  const body: unknown = await res.json().catch(() => null);
  return res.ok ? { ok: true, data: body } : { ok: false, status: res.status, code: (body as { code?: string } | null)?.code ?? "ERROR" };
}
export const readProfile = () => mine(profileGet);
export const readCv = () => mine(cvRead);
export const readSaved = (query?: Query) => mine(savedList, query);
export const readAlerts = () => mine(alertsGet);
export const readAlert = (id: string) => mine(alertsGet, { id }); // one alert for the edit form (/account/alerts?edit=<id>); 404 ALERT_NOT_FOUND for another candidate's
export const readTracker = () => mine(trackerGet); // B31
export const readNotices = (query?: Query) => mine(noticesGet, query); // B38: ?after=
/** The signed-in candidate's email, whether it is confirmed, and the name given at sign-up (the profile has its own, empty until it is saved), or null when signed out. */
export const readAccountEmail = cache(async (): Promise<{ email: string; verified: boolean; name: string } | null> => {
  const s = await sessionOnce(candidateAuth(), await headers()).catch(() => null);
  return s ? { email: s.user.email, verified: s.user.emailVerified === true, name: s.user.name ?? "" } : null;
});
export const readSecurity = () => mine(securityGet); // B40: passwordChangedAt and signInMethods
export const readDataAccess = () => mine(dataAccessGet); // B41: who viewed my data
export const readDidYouApply = () => mine(promptsGet);
export const readNotificationSettings = () => mine(settingsGet);
export const readMyJob = (jobId: string) => mine(jobGet, { id: jobId }); // saved or tracked state of one job
export const readCases = (query?: Query) => mine(caseList, query);
export const readCase = (id: string) => mine((r) => caseRead(r, id));
export const readCaseTimeline = (id: string) => mine((r) => caseTimeline(r, id));
export const readCaseDocuments = (id: string) => mine((r) => docsList(r, id)); // P17c: the copies this candidate uploaded to one case

/**
 * P17c: the two emailed-link pages (/unsubscribe, /data-request) read what the link would do through the API's own GET handlers, with the request's headers (the
 * client address for the rate limit). No sign-in: the token is the credential. A refusal comes back as { ok: false, status, code }; neither read changes anything.
 */
async function linkRead(handler: (r: Request) => Promise<Response>, path: string, query: Record<string, string>): Promise<ReadResult> {
  const url = new URL(path, siteOrigin());
  url.search = new URLSearchParams(query).toString();
  const res = await handler(new Request(url, { headers: await headers() }));
  const body: unknown = await res.json().catch(() => null);
  return res.ok ? { ok: true, data: body } : { ok: false, status: res.status, code: (body as { code?: string } | null)?.code ?? "ERROR" };
}
export const readUnsubscribe = (token: string, scope: string) => linkRead(unsubscribeGet, "/api/alerts/unsubscribe", { token, scope });
export const readDataRequest = (token: string) => linkRead((r) => dataRequestGet(r, "candidate"), "/api/data-request", { token });

// The sitemap is for crawlers, so it has no per-address limit (a limited crawler would see an empty site); instead each answer is kept
// SITEMAP_TTL_MS per instance, so a flood costs the database one read per file per instance in that time.
// ponytail: per-instance memo; a shared cache if many instances make it matter
const SITEMAP_TTL_MS = 5 * 60_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function kept<T>(key: string, load: () => Promise<T>): Promise<T> {
  const m = memo.get(key);
  if (m && Date.now() - m.at < SITEMAP_TTL_MS) return m.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}
export const readSitemapIds = () => kept("ids", () => sitemapIds(getPool()));
export const readSitemapPart = (id: string): Promise<SitemapEntry[] | null> => kept(`part:${id}`, () => sitemapPart(getPool(), id));
/** B21: the sitemap index file (/sitemap-index.xml), listing every file of readSitemapIds. */
export const readSitemapIndex = async () => sitemapIndexXml(siteOrigin(), await readSitemapIds());
export const siteOrigin = () => new URL(candidateSettings(process.env).baseURL).origin;

/** P1: whether a candidate is signed in, for a page that shows something different to them (the home page hides its "Create a free account" block). The page's own session check, not a gated read: it costs no read-limit count. A failure counts as signed out. */
export const readSignedIn = async (): Promise<boolean> => signedInCandidate(await headers()).then((l) => !("refused" in l), () => false);

/**
 * P1: what the site frame (header and footer) needs on every page: the standing line with the day the rules were last checked, and the site origin
 * (for the JSON-LD). The day comes from the rules in force (the same value as GET /api/minimums, rulesCheckedOn), kept by getRules, so a warm read
 * costs no statement. Stage 3 step 4: nothing of the visitor any more (the header follows the hint cookie, packages/ui HINT_SCRIPT), so the frame
 * no longer makes every page per visit. A failure shows the frame without the line or the origin: the frame must never be the reason a page fails.
 * Stage 3 step 3: a build with no DATABASE_URL (CI) marks every page per visit instead of prerendering frames without the line; a build that reaches
 * the database prerenders them (the rules confirm clears them, ALL_PAGES).
 */
export async function readSiteFrame(): Promise<{ standingLine: string | null; origin: string | null }> {
  if (!process.env.DATABASE_URL) await connection();
  const line = await Promise.resolve().then(() => getRules(getPool())).then((r) => standingLine(r.minimums.checkedOn), () => null);
  return { standingLine: line, origin: (() => { try { return siteOrigin(); } catch { return null; } })() };
}
