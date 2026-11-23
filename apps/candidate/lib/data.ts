// The data layer of the candidate pages (nextjs.org/docs/app/guides/data-security): a Server Component reads only through here, never through
// @portal/db or its own Route Handlers, so the visitor cap of 6 jobs and the read limit apply to a page as they do to the API (gatedRead).
// `server-only` is Next's own copy (aliased by its compilers): importing this file from a Client Component fails the build. Not in packages/db,
// which the CLIs and vitest load outside Next.
import "server-only";
import { headers } from "next/headers";
import {
  checkerRead, companyRead, countJobView, gatedRead, getPool, guideRead, helpRead, jobRead, jobsRead, legalRead, minimumsRead, occupationRead, occupationsRead, sectorsRead,
  similarRead, sitemapIds, sitemapPart, updatesRead, type ReadResult, type SitemapEntry, type Work,
} from "@portal/db";
import { candidateSettings } from "@portal/auth";
import { alertsGet } from "./alerts";
import { profileGet, promptsGet, savedList, settingsGet, jobGet } from "./account";
import { caseList, caseRead, caseTimeline } from "./cases";
import { signedInCandidate } from "./candidate";
import { cvRead } from "./files";

type Query = ConstructorParameters<typeof URLSearchParams>[0];
const read = (work: Work) => async (query?: Query): Promise<ReadResult> => gatedRead(await headers(), new URLSearchParams(query), signedInCandidate, work);

export const readJobs = read(jobsRead);
export const readJob = read(jobRead);
export const readSimilar = read(similarRead);
export const readCompany = read(companyRead);
export const readOccupation = read(occupationRead);
export const readHelp = read(helpRead);
export const readUpdates = read(updatesRead);
export const readChecker = read(checkerRead);
export const readLegal = read(legalRead); // R5: ?purpose=signup_terms or privacy_notice
export const readSectors = read(sectorsRead); // B1: the sectors with their live job counts
export const readGuide = read(guideRead); // B1: ?slug
export const readMinimums = read(minimumsRead); // B5: the minimums in force, no occupation
export const readOccupations = read(occupationsRead); // B12: every code with title, slug and list status, for the pickers

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
export const readDidYouApply = () => mine(promptsGet);
export const readNotificationSettings = () => mine(settingsGet);
export const readMyJob = (jobId: string) => mine(jobGet, { id: jobId }); // saved or tracked state of one job
export const readCases = (query?: Query) => mine(caseList, query);
export const readCase = (id: string) => mine((r) => caseRead(r, id));
export const readCaseTimeline = (id: string) => mine((r) => caseTimeline(r, id));

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
export const siteOrigin = () => new URL(candidateSettings(process.env).baseURL).origin;
