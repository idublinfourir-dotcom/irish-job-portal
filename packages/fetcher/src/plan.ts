// Turns one assessment into the rows to write. Pure: no database, no clock, no network. Design: step5/L8-DESIGN.md 3.7.
import type { Assessment } from "@portal/rules";
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
  if (m?.failure?.kind === "model error") return { action: "defer", why: m.failure.why };

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

  // The chain says queue, but a queued advert needs a job row and its text, and this one broke the limits that guard both.
  if (a.stage === "0 advert too long (admin queue)") return reject(a.stage);

  const passRoute = a.bucket === "stated_pay" || a.bucket === "big_company" ? a.bucket : null;
  let result: AdvertRow["result"];
  if (passRoute) result = "passed";
  else if (a.bucket === "queue" || a.bucket === "public_hse" || a.bucket === "public_s38") result = "queued";
  else return reject(a.stage); // rejected, no_salary: the chain's own reason is kept, with or without a link
  // Only a job needs a link (own_page_url), and the site shows it, so nothing but http and https is ever stored there.
  if (!link) return reject("0 no advert link");
  let stage: string = a.stage;
  if (result === "passed" && a.scamFlag) {
    result = "queued";
    stage = "0 scam wording (admin queue)";
  }

  const job: JobRow = {
    title: cut(advert.title, 300),
    employerName: cut(advert.employer, 300),
    county: countyOf(advert.location),
    sector: a.sector,
    occupationCode: a.occupationCode,
    salaryLow: euros(a.salaryLow),
    salaryHigh: euros(a.salaryHigh),
    passRoute: result === "passed" ? passRoute : null,
    status: result === "passed" ? "live" : "in_review",
    ownPageUrl: link,
  };
  return { action: "job", advert: row(result, stage), job, text: clean(advert.description) };
}

/** The close reasons the fetcher may undo. Any other reason on a closed job means staff closed it. */
export const FETCHER_CLOSED = ["closed", "expired", "recheck_failed"];

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
  // closed by the fetcher: it comes back only if it passes. A queued or rejected advert leaves it closed (design 4.3 finding 5).
  return p.action === "job" && p.job.status === "live" ? "reopen" : "advert";
}
