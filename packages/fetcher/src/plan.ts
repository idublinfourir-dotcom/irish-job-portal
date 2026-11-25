// Turns one assessment into the rows to write. Pure: no database, no clock, no network. Design: step5/L8-DESIGN.md 3.7.
import { PASS_ROUTE, type Assessment } from "@portal/rules";
import type { RawAdvert } from "@portal/sources";
import { countyOf } from "./county";
import type { AdvertRow, Change, JobRow, Known, MatchResult, Plan } from "./types";

// NUL is refused by Postgres in text; a lone surrogate is harmless (the driver writes U+FFFD).
const clean = (s: string) => s.replaceAll("\0", "");
/** First `max` code points. Looks at no more than 2 * max units, so a huge string costs nothing. */
const cut = (s: string, max: number) => Array.from(clean(s).slice(0, max * 2)).slice(0, max).join("");
const cutOrNull = (s: string | null | undefined) => (s ? cut(s, 300) || null : null);
// integer columns hold up to 2,147,483,647; a number the rules read from hostile text may not fit
const euros = (n: number | null) => (n !== null && Number.isFinite(n) && n >= 0 && n <= 2_000_000_000 ? Math.round(n) : null);

function usableLink(raw: string): string | null {
  const url = clean(raw);
  if (!url || url.length > 2000) return null;
  try {
    const p = new URL(url).protocol;
    return p === "http:" || p === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function planAdvert(advert: RawAdvert, a: Assessment, m: MatchResult | null): Plan {
  // No answer, or one that cannot be used, is not a no: the advert comes back next run (#298).
  // ponytail: asked again every run with no cap; add one if failed answers ever eat the model's daily requests.
  if (m?.failure) return { action: "defer", why: m.failure.why };

  const link = usableLink(advert.url);
  const row = (result: AdvertRow["result"], stage: string): AdvertRow => ({
    externalId: advert.id,
    url: link,
    title: cut(advert.title, 300),
    employerName: cut(advert.employer, 300),
    result,
    stage: cut(stage, 200), // the database holds 200 (migration 0006), so a long stage can never make an advert unsaveable
    reason: cutOrNull(a.irishReason ?? a.contractReason),
    quotedEvidence: cutOrNull(a.reason ?? m?.quote),
    matcherModel: m?.modelId ? cut(m.modelId, 100) : null,
  });
  const reject = (stage: string): Plan => ({ action: "reject", advert: row("rejected", stage) });

  // #298, #299: what carries the badge goes live, everything else is refused, the chain's "admin queue" stages too, with their own words kept. Nobody is asked.
  const passRoute = PASS_ROUTE[a.bucket];
  if (!passRoute) return reject(a.stage); // with or without a link
  // Only a job needs a link (own_page_url), and the site shows it, so nothing but http and https is ever stored there.
  if (!link) return reject("0 no advert link");
  if (a.scamFlag) return reject("0 scam wording (admin queue)");

  const job: JobRow = {
    title: cut(advert.title, 300),
    employerName: cut(advert.employer, 300),
    county: countyOf(advert.location),
    sector: a.sector,
    occupationCode: a.occupationCode,
    salaryLow: euros(a.salaryLow),
    salaryHigh: euros(a.salaryHigh),
    passRoute,
    status: "live", // ponytail: the store can still write a waiting job ("in_review", "queued"), no plan asks for one; take it out when the staff queue page goes
    ownPageUrl: link,
  };
  return { action: "job", advert: row("passed", a.stage), job, text: clean(advert.description) };
}

/** The close reasons the fetcher may undo. Any other reason on a closed job means staff closed it. */
export const FETCHER_CLOSED = ["closed", "expired", "recheck_failed", "source_stale"];

/**
 * What to do with a known advert that came back with its text (design 3.8). Pure.
 * "same": nothing. "held": the job is staff's (in_review, hidden...), so only `gone_at` is cleared. "settle": staff closed the job, so only the hash
 * is kept up to date. "again": assess it once more. An advert that was gone is always assessed again; a row with no hash counts as changed.
 */
export function stateOf(k: Known, hash: string): "same" | "held" | "settle" | "again" {
  if (k.status !== null && k.status !== "live" && k.status !== "closed") return "held";
  if (k.status === "closed" && !FETCHER_CLOSED.includes(k.closeReason ?? "")) return "settle";
  return !k.gone && k.hash === hash ? "same" : "again";
}

/** Which write a re-assessed known advert needs, by what its job is and what the plan now says (the table in 3.8). */
export function changeOf(k: Known, p: Exclude<Plan, { action: "defer" }>): Change {
  if (k.jobId === null) return p.action === "job" ? "insert" : "advert";
  if (k.status === "live") return p.action === "reject" ? "close" : "update";
  // closed by the fetcher: it comes back only if it passes. A rejected advert leaves it closed (design 4.3 finding 5).
  return p.action === "job" && p.job.status === "live" ? "reopen" : "advert";
}
