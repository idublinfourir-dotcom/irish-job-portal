import { readSitemapIndex } from "../../lib/data";

// The sitemap index (B21): at /sitemap-index.xml (Next's own /sitemap.xml name clashes with app/sitemap.ts), lists every /sitemap/<id>.xml file. Next's generateSitemaps makes the files but no index. Read at request time: the build has no database.
export const dynamic = "force-dynamic";

export async function GET() {
  return new Response(await readSitemapIndex(), { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
}
