import type { MetadataRoute } from "next";
import { readSitemapIds, readSitemapPart, siteOrigin } from "../lib/data";
import { companyPath, jobPath, occupationPath } from "../lib/paths";

// S13: /sitemap/<id>.xml, one file per part of live jobs, company pages and occupation pages (packages/db/src/sitemap.ts). Read at request time:
// the build has no database. No robots file yet (it waits for the pages); it will list these files.
export const dynamic = "force-dynamic";
const PATH = { job: jobPath, company: companyPath, occupation: occupationPath };

export async function generateSitemaps() {
  // Next also calls this at build time to prerender the files; the build has no database, so it gets none there and every id is read per request.
  if (process.env.NEXT_PHASE === "phase-production-build") return [];
  return (await readSitemapIds()).map((id) => ({ id }));
}
export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  return ((await readSitemapPart(await props.id)) ?? []).map((e) => ({ url: origin + PATH[e.kind](e.key), ...(e.lastModified ? { lastModified: e.lastModified } : {}) }));
}
