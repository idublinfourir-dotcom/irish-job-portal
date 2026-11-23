import type { SitemapEntry } from "@portal/db";
import type { MetadataRoute } from "next";
import { readSitemapIds, readSitemapPart, siteOrigin } from "../lib/data";
import { occupationSlug } from "../lib/occupations";
import { companyPath, jobPath, occupationPath } from "../lib/paths";

// S13: /sitemap/<id>.xml, one file per part of live jobs, company pages and occupation pages (packages/db/src/sitemap.ts). Read at request time:
// the build has no database. No robots file yet (it waits for the pages); it will list these files.
export const dynamic = "force-dynamic";

export async function generateSitemaps() {
  // Next also calls this at build time to prerender the files; the build has no database, so it gets none there and every id is read per request.
  if (process.env.NEXT_PHASE === "phase-production-build") return [];
  return (await readSitemapIds()).map((id) => ({ id }));
}
export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  const path = (e: SitemapEntry) =>
    e.kind === "job" ? jobPath({ id: e.key, title: e.title ?? "", county: e.county ?? null }) : e.kind === "company" ? companyPath(e.key) : occupationPath(occupationSlug(e.key) ?? e.key);
  return ((await readSitemapPart(await props.id)) ?? []).map((e) => ({ url: origin + path(e), ...(e.lastModified ? { lastModified: e.lastModified } : {}) }));
}
