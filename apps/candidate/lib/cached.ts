// Stage 3 steps 3 and 5 (AUDIT section 5, "Before the first page is cached"): the loaders of the cached pages (legal, guides, help). They call the read
// work directly as a visitor: no headers, no session, no read-limit count (nothing of the visitor can reach a cached page), and a failure throws, so a
// regeneration that fails keeps the last good copy instead of caching an error. A missing page is null (the page shows its 404 or "not published").
// A build with no DATABASE_URL (CI) makes the page per visit instead (connection()), never a cached failure.
import "server-only";
import { connection } from "next/server";
import { BadContentInput, getPool, guideRead, guidesRead, helpListRead, helpRead, legalRead, updatesRead, type Work } from "@portal/db";

async function load(work: Work, query: Record<string, string> = {}): Promise<unknown> {
  if (!process.env.DATABASE_URL) await connection();
  try {
    return await work(getPool(), new URLSearchParams(query), true);
  } catch (e) {
    if (e instanceof BadContentInput) return null; // a slug that cannot exist is the 404 page, not an error
    throw e;
  }
}
export const cachedLegal = (purpose: string) => load(legalRead, { purpose });
export const cachedGuides = () => load(guidesRead);
export const cachedGuide = (slug: string) => load(guideRead, { slug });
export const cachedUpdates = () => load(updatesRead);
export const cachedHelpList = () => load(helpListRead);
export const cachedHelp = (slug: string) => load(helpRead, { slug });
