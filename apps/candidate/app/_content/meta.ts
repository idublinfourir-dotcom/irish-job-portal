// The title and description of a content page (frame 01 SEO spec: title 60 characters or fewer plus the brand, description 120 to 160), with its canonical address.
import type { Metadata } from "next";
import { siteOrigin } from "../../lib/data";
import { pageDescription, pageMetadata, pageTitle } from "../../lib/seo";

/** A description of 120 to 160 characters: the page's own sentence, then fixed lines until it is long enough, then cut at 160 (never a typed figure). */
export function fit(text: string, fillers: readonly string[] = [" Rules are checked against DETE guidance.", " Free for candidates.", " Irish Work Permit helps you find jobs where a permit is realistic."]): string {
  let d = text.replace(/\s+/g, " ").trim();
  for (const f of fillers) if (d.length < 120) d += f;
  const out = pageDescription(d);
  return out.length < 120 && d.length > 160 ? `${d.slice(0, 159)}…` : out; // one very long word has no space to cut at: cut it hard, still 120 to 160
}

/** The site's own address, or null where there is none (a build, a test). */
export const originOrNull = () => { try { return siteOrigin(); } catch { return null; } };

/** Next metadata for a page at `path` (made by lib/paths.ts). The site origin can be missing in a test: the title and description are still set. */
export function meta(title: string, description: string, path?: string, noindex = false): Metadata {
  const d = fit(description), origin = originOrNull();
  if (path && origin) return pageMetadata({ title, description: d, path, origin, noindex });
  return { title: pageTitle(title), description: d, ...(noindex ? { robots: { index: false, follow: false } } : {}) };
}
