import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";

/** A page's title (60 characters or fewer, then the brand) and description (120 to 160 characters). The site-wide noindex stays in the layout (the SEO slice flips it). */
export const meta = (title: string, description: string, extra: Metadata = {}): Metadata => ({ title: `${title} | ${SITE_NAME}`, description, ...extra });
/** A page whose address carries a token: no referrer leaves with a click, and nothing indexes it. */
export const tokenMeta = (title: string, description: string): Metadata => meta(title, description, { referrer: "no-referrer", robots: { index: false, follow: false } });
