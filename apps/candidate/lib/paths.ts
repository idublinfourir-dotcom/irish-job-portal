// The one place a public page's path is made (decision #288: readable addresses, plural folders); change a path only here. The sitemap, canonical
// links and JSON-LD all use these. The job address ends in the job's id, which is all the page looks up, so a changed title never breaks a link.
const slug = (s: string, max: number) => s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, max).replace(/-$/, "");

/** `/jobs/<title>-<county>-<id>`, for example `/jobs/staff-nurse-cork-4821`. A page redirects to this when the address it was opened on differs. */
export const jobPath = (j: { id: string; title: string; county: string | null }) =>
  `/jobs/${[slug(j.title, 60) || "job", j.county ? slug(j.county, 20) : ""].filter(Boolean).join("-")}-${j.id}`;
/** The job id at the end of the `[job]` address segment, or null when it does not end in one. */
export const jobIdOf = (segment: string) => /^(?:.*-)?([0-9]{1,18})$/.exec(segment)?.[1] ?? null;
export const companyPath = (companySlug: string) => `/companies/${encodeURIComponent(companySlug)}`;
/** By name slug (`occupationSlug` in lib/occupations.ts gives it from a code; `occupationCodeOfSlug` goes back). */
export const occupationPath = (nameSlug: string) => `/occupations/${encodeURIComponent(nameSlug)}`;
export const guidePath = (guideSlug: string) => `/guides/${encodeURIComponent(guideSlug)}`;
export const updatePath = (updateSlug: string) => `/updates/${encodeURIComponent(updateSlug)}`;
export const helpPath = (helpSlug: string) => `/help/${encodeURIComponent(helpSlug)}`;
/** The legal text of a consent purpose (frame C22's sidebar); a purpose with no public page gives null. */
const LEGAL = new Map([["privacy_notice", "/privacy"], ["signup_terms", "/terms"], ["cookie_policy", "/cookies"], ["employer_acceptable_use", "/employer-acceptable-use"], ["data_retention", "/data-retention"]]);
export const legalPath = (purpose: string) => LEGAL.get(purpose) ?? null;
/** The pages with no data behind them (`STATIC_PAGES` in packages/db/src/sitemap.ts). */
const STATIC = new Map([["home", "/"], ["jobs", "/jobs"], ["companies", "/companies"], ["guides", "/guides"], ["updates", "/updates"], ["help", "/help"], ["eligibility-checker", "/eligibility-checker"], ["permit-services", "/permit-services"]]);
export const staticPath = (key: string) => STATIC.get(key) ?? null;
