// The SEO helpers every public candidate page calls (step 16 P2; frame 01's SEO spec): the canonical address (made by paths.ts, #288), the title and
// description with their size limits, the robots rule, and the JSON-LD builders. Pure: no database, no request. A page's generateMetadata returns
// pageMetadata(...) and renders <script type="application/ld+json">{jsonLd(...)}</script> (React puts the text in a script unescaped, so no
// dangerouslySetInnerHTML is needed).
import { SITE_NAME } from "@portal/ui";
import type { Metadata } from "next";

/**
 * Indexing is OFF until launch and driven by this one setting: SITE_INDEXABLE=1 turns it on, anything else (or unset) keeps every page noindex and
 * robots.txt disallowing everything. Launch is the setting changing, not a code change.
 */
export const siteIndexable = (env: Record<string, string | undefined> = process.env) => env.SITE_INDEXABLE === "1";

export const TITLE_MAX = 60;
export const DESCRIPTION_MIN = 120;
export const DESCRIPTION_MAX = 160;
const BRAND_SUFFIX = ` | ${SITE_NAME}`;

/** Cuts `s` to at most `max` characters at a word end, with an ellipsis counted inside the limit. Shorter text is returned as it is. */
function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), Math.floor(max / 2))).replace(/[\s,;:.-]+$/, "")}…`;
}

/** `<title> | Irish Work Permit`, with the title part at most 60 characters (a long job title is cut, never the page refused). */
export const pageTitle = (title: string) => clamp(title, TITLE_MAX) + BRAND_SUFFIX;
/** A description cut to 160 characters. One shorter than 120 is returned as written: descriptionProblem names it, the page's test fails on it. */
export const pageDescription = (text: string) => clamp(text, DESCRIPTION_MAX);

/** The size rule broken by a title part (without the brand), or null. */
export const titleProblem = (title: string) => (title.trim() === "" ? "title is empty" : title.length > TITLE_MAX ? `title is ${title.length} characters, over ${TITLE_MAX}` : null);
/** The size rule broken by a description, or null. */
export function descriptionProblem(text: string) {
  return text.length < DESCRIPTION_MIN ? `description is ${text.length} characters, under ${DESCRIPTION_MIN}` : text.length > DESCRIPTION_MAX ? `description is ${text.length} characters, over ${DESCRIPTION_MAX}` : null;
}

/** The canonical address: the site origin plus a path made by lib/paths.ts. Never carries a query or a fragment (a filtered search is noindex, not a second canonical). */
export function canonicalUrl(origin: string, path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`canonical path must start with a single /: ${path}`);
  return new URL(path.split(/[?#]/)[0]!, origin).href;
}

/**
 * A search page with any filter, sort or cursor in its address is noindex (#287): every such address is a second copy of /jobs. Takes the page's
 * searchParams (values may be a string, a list or undefined).
 */
export const isFilteredSearch = (params: Record<string, string | string[] | undefined>) =>
  Object.values(params).some((v) => (Array.isArray(v) ? v.some((x) => x !== "") : v !== undefined && v !== ""));

export type PageSeo = { title: string; description: string; path: string; origin: string; noindex?: boolean };

/** The Next metadata of a page: title, description, canonical and robots. Noindex when the page asks for it or while the site is not indexable. */
export function pageMetadata({ title, description, path, origin, noindex = false }: PageSeo, env: Record<string, string | undefined> = process.env): Metadata {
  const index = siteIndexable(env) && !noindex;
  return {
    title: pageTitle(title),
    description: pageDescription(description),
    alternates: { canonical: canonicalUrl(origin, path) },
    robots: index ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/** The root layout's robots: indexable by default once SITE_INDEXABLE=1, noindex before. Account and sign-in pages pass noindex through pageMetadata. */
export const siteRobots = (env: Record<string, string | undefined> = process.env): NonNullable<Metadata["robots"]> => (siteIndexable(env) ? { index: true, follow: true } : { index: false, follow: false });

// ===== JSON-LD (schema.org) =====
type Ld = Record<string, unknown>;

/** JSON for a <script type="application/ld+json"> body. `<` is escaped so a value can never close the script. */
export const jsonLd = (data: Ld): string => JSON.stringify(data).replaceAll("<", "\\u003c");

/** Site-wide, on every page. */
export const organizationLd = (origin: string): Ld => ({ "@context": "https://schema.org", "@type": "Organization", name: SITE_NAME, url: new URL("/", origin).href });
export const websiteLd = (origin: string): Ld => ({ "@context": "https://schema.org", "@type": "WebSite", name: SITE_NAME, url: new URL("/", origin).href });

/** An occupation page. `registrationBody` is the regulator the role needs (NMBI, Medical Council, PSI ...), when the rules name one. */
export function occupationLd(o: { name: string; code?: string | null; url: string; registrationBody?: { name: string; url: string } | null }): Ld {
  return {
    "@context": "https://schema.org", "@type": "Occupation", name: o.name, url: o.url,
    ...(o.code ? { occupationalCategory: o.code } : {}),
    ...(o.registrationBody ? { qualifications: `Registration with ${o.registrationBody.name}`, sameAs: o.registrationBody.url } : {}),
  };
}

export type JobLdInput = {
  source: string; title: string; advertText: string | null; postedAt: string; closesAt: string | null; url: string; employerName: string; employerWebsite?: string | null;
  county: string | null; salaryLow: number | null; salaryHigh: number | null; contractType?: string | null;
};

/**
 * Google job markup, ONLY for a job an employer posted on this site (decision #92: marking up a fetched job, or one staff posted for a company, would
 * be posting on a company's behalf without its authorisation). Anything else gives null, so a page that always calls this can never mark up a fetched
 * job. A job with no advert text gives null too (the description is required). ponytail: source "agency" gets no markup until the owner decides it.
 */
export function jobPostingLd(j: JobLdInput): Ld | null {
  if (j.source !== "employer" || !j.advertText) return null;
  return {
    "@context": "https://schema.org", "@type": "JobPosting", title: j.title, description: j.advertText, datePosted: j.postedAt, url: j.url,
    ...(j.closesAt ? { validThrough: j.closesAt } : {}),
    hiringOrganization: { "@type": "Organization", name: j.employerName, ...(j.employerWebsite ? { sameAs: j.employerWebsite } : {}) },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", ...(j.county ? { addressRegion: j.county } : {}), addressCountry: "IE" } },
    ...(j.salaryLow !== null ? { baseSalary: { "@type": "MonetaryAmount", currency: "EUR", value: { "@type": "QuantitativeValue", minValue: j.salaryLow, ...(j.salaryHigh !== null ? { maxValue: j.salaryHigh } : {}), unitText: "YEAR" } } } : {}),
  };
}
