// The data layer of the candidate pages (nextjs.org/docs/app/guides/data-security): a Server Component reads only through here, never through
// @portal/db or its own Route Handlers, so the visitor cap of 6 jobs and the read limit apply to a page as they do to the API (gatedRead).
// `server-only` is Next's own copy (aliased by its compilers): importing this file from a Client Component fails the build. Not in packages/db,
// which the CLIs and vitest load outside Next.
import "server-only";
import { headers } from "next/headers";
import {
  checkerRead, companyRead, gatedRead, getPool, helpRead, jobRead, jobsRead, legalRead, occupationRead, similarRead, sitemapIds, sitemapPart, updatesRead,
  type ReadResult, type SitemapEntry, type Work,
} from "@portal/db";
import { candidateSettings } from "@portal/auth";
import { signedInCandidate } from "./candidate";

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
