import type { MetadataRoute } from "next";
import { siteOrigin } from "../lib/data";
import { siteIndexable } from "../lib/seo";

// P2: while the site is not indexable (SITE_INDEXABLE unset) everything is disallowed and no sitemap is listed; at launch the public pages are allowed,
// the signed-in areas and the API stay out, and the sitemap index (B21) is listed. Read per request so the setting is live: the build has no settings.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  if (!siteIndexable()) return { rules: { userAgent: "*", disallow: "/" } };
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/account", "/login", "/signup", "/verify", "/reset", "/kit"] },
    sitemap: `${siteOrigin()}/sitemap-index.xml`,
  };
}
