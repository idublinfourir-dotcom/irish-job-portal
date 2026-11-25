import type { SitemapEntry } from "@portal/db";
import type { MetadataRoute } from "next";
import { readSitemapIds, readSitemapPart, siteOrigin } from "../lib/data";
import { occupationSlug } from "../lib/occupations";
import { companyPath, guidePath, helpPath, jobPath, legalPath, occupationPath, staticPath } from "../lib/paths";

// S13: /sitemap/<id>.xml, one file per part of live jobs, company pages and occupation pages, plus the static pages, legal texts, guides and
// help pages (packages/db/src/sitemap.ts). /sitemap-index.xml lists them all (app/sitemap-index.xml/route.ts). Read at request time: the build has no database.
export const dynamic = "force-dynamic";

export async function generateSitemaps() {
  // Next also calls this at build time to prerender the files; the build has no database, so it gets none there and every id is read per request.
  if (process.env.NEXT_PHASE === "phase-production-build") return [];
  return (await readSitemapIds()).map((id) => ({ id }));
}
const path = (e: SitemapEntry) => {
  switch (e.kind) {
    case "job": return jobPath({ id: e.key, title: e.title ?? "", county: e.county ?? null });
    case "company": return companyPath(e.key);
    case "occupation": return occupationPath(occupationSlug(e.key) ?? e.key);
    case "guide": return guidePath(e.key);
    case "help": return helpPath(e.key);
    case "legal": return legalPath(e.key);
    case "page": return staticPath(e.key);
  }
};
export default async function sitemap(props: { id: Promise<string> }): Promise<MetadataRoute.Sitemap> {
  const origin = siteOrigin();
  return ((await readSitemapPart(await props.id)) ?? []).flatMap((e) => {
    const p = path(e);
    return p === null ? [] : [{ url: origin + p, ...(e.lastModified ? { lastModified: e.lastModified } : {}) }];
  });
}
