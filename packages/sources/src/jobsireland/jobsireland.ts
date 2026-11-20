// D1 wave 1: JobsIreland.ie, the Department of Social Protection's public employment service. General permit jobs must be advertised there for
// 28 days (the Labour Market Needs Test), so it carries the care, chef and hospitality jobs the employer sites lack. #63: a fetch source; the owner
// accepts the risk. Its own open JSON API, probed 20 Nov 2026 from Dublin and US data centres (step15/d1-probe-results.md):
//   GET /api/jobs?offset=N&limit=100  the live list: { totalCount, data: [card] }
//   GET /api/jobs/<id>                one job with jobDescription, expiration, hoursPerWeekText and the pay fields
// The job's own page is the site's vacancyBaseUrl (its /assets/config): https://jobsireland.ie/search-jobs?jobId=<id>.
import { FetchFailedError, type BoardFetch, type RawAdvert, type SourceAdapter } from "../types";
import { RATE_LIMITED, asArr, asNum, asObj, asStr, at, get, guard, isObj, job, makeCaller, safeName, text, type Obj } from "../ats/shared";

export const JI_ORIGIN = "https://jobsireland.ie";
const PAGE = 100;
export const JI_MAX_PAGES = 100; // 10,000 jobs; the list had 4,320 on 20 Nov 2026
export const JI_GAP_MS = 1_000; // at most one request a second to the host
const ID = /^[0-9a-f]{32}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Community Employment (VTY4) and the Work Placement and Experience Programme (VTY3) are schemes for people on Irish social welfare payments,
// never a permit job: about two thirds of the list (2,914 of 4,319 on 20 Nov), dropped before any detail read.
const SCHEMES = new Set(["VTY3", "VTY4"]);
const IRELAND = "CTY109"; // the list's country code for Ireland (4,286 of 4,319; one other code, 32 with no location)

const NA = /^n\/?a$/i; // "N/A", as some cards write a missing city
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : "");
const name = (v: unknown) => (isObj(v) ? str(get(v, "name")) : "");
const day = (v: unknown) => (DAY.test(str(v)) ? str(v) : "");
/** A yyyy-mm-dd day before `today` (also yyyy-mm-dd). An unreadable date is no date. */
const past = (v: unknown, today: string) => !!day(v) && day(v) < today;

/** The place, as "City, Co. County, Ireland"; "Ireland" when the job gives none; null when the job is in another country. Pure. */
export function jiLocation(j: Obj): string | null {
  const l = get(j, "location");
  if (!isObj(l)) return "Ireland";
  const c = get(l, "COUNTRY");
  if (c !== undefined && c !== null && c !== IRELAND) return null;
  return [...new Set([text(str(get(l, "CITY"))), text(str(get(l, "COUNTY")))].filter((x) => x && !NA.test(x))), "Ireland"].join(", ").slice(0, 300);
}

const commas = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
/** A pay amount as a year's pay: under 200 is an hourly wage, counted at 39 hours a week as the salary reader counts it (rules readSalary). */
const yearly = (n: unknown) => (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1_000_000 ? null : n < 200 ? n * 39 * 52 : n);

/**
 * The pay, as salary-box text the salary reader reads ("€30,000 to €39,999 a year"), the way the site's own page shows it: `actualWages` when given
 * (the dry run of 20 Nov saw it with `displaySalary` null), else the lowest and highest of the pay bands (`offeredRemunerationPackages`, minimumAmount
 * and maximumAmount), and those only when the employer chose to show them (`displaySalary` true). An amount that is not a sane number is left out. Pure.
 */
export function jiSalary(j: Obj): string {
  const wage = yearly(get(j, "actualWages"));
  if (wage !== null) return `€${commas(wage)} a year`;
  if (get(j, "displaySalary") !== true) return "";
  const bands = get(j, "offeredRemunerationPackages");
  const list = Array.isArray(bands) ? bands.slice(0, 50).filter(isObj) : [];
  const lows = list.map((b) => yearly(get(b, "minimumAmount"))).filter((n) => n !== null);
  const highs = list.map((b) => yearly(get(b, "maximumAmount"))).filter((n) => n !== null);
  const lo = lows.length ? Math.min(...lows) : null;
  const hi = highs.length ? Math.max(...highs) : null;
  if (lo === null && hi === null) return "";
  return lo !== null && hi !== null && hi > lo ? `€${commas(lo)} to €${commas(hi)} a year` : `€${commas((lo ?? hi)!)} a year`;
}

/**
 * One job (its list card with its detail laid over it) as the advert every kind produces, or null when it is not kept: in another country, not
 * active, or past its closing date (`expiration`, or the card's `dateClosed`). Hours, the posted day and the closing day head the text. Pure.
 */
export function jiAdvert(board: string, ext: string, j: Obj, today: string): RawAdvert | null {
  const location = jiLocation(j);
  const status = get(j, "statusCode");
  if (location === null || get(j, "active") === false || (status !== undefined && status !== "Active")) return null;
  if (past(get(j, "expiration"), today) || past(get(j, "dateClosed"), today)) return null;
  const hours = text(str(get(j, "hoursPerWeekText"))).slice(0, 40);
  const closes = day(get(j, "expiration")) || day(get(j, "dateClosed"));
  const head = [hours && `Hours per week: ${hours}`, day(get(j, "datePosted")) && `Posted: ${day(get(j, "datePosted"))}`, closes && `Closing date: ${closes}`].filter(Boolean).join("\n");
  const description = [head, text(str(get(j, "jobDescription")))].filter(Boolean).join("\n\n");
  const etype = [name(get(j, "employmentType")), name(get(j, "contractType"))].filter(Boolean).join(", ");
  return job("jobsireland", board, ext, text(str(get(j, "companyName"))), text(str(get(j, "positionTitle"))), location, description, `${JI_ORIGIN}/search-jobs?jobId=${ext}`, etype, jiSalary(j));
}

/** `maxDetails`: detail reads a run. `now`: the clock for the closing date (a fake in tests). */
export type JobsIrelandBoard = { board: string; maxDetails: number; now?: () => Date };

/**
 * Pages the list (100 a page) until `totalCount` or an empty page, then reads the detail of each kept job not in `known` (new, or due for its weekly
 * re-read), at most `maxDetails` a run; the rest are seen (nothing closes) and wait for the next run. The list alone drops welfare scheme places,
 * jobs in another country, inactive ones and ones whose `dateClosed` is past, with no detail read. A detail past its closing date is dropped and
 * unseen, so a known one closes. A detail that fails is skipped (seen, nothing saved); a refusal for the rate limit stops the detail reads for this
 * run, keeping what was read. A list page that fails fails the board, and nothing closes.
 */
export const fetchJobsIreland: SourceAdapter<JobsIrelandBoard> = (b, known, fetch, opts) =>
  guard(b.board, async () => {
    safeName(b.board, b.board);
    if (!Number.isInteger(b.maxDetails) || b.maxDetails < 0) throw new FetchFailedError(b.board, "bad detail cap");
    const call = makeCaller(b.board, fetch, JI_ORIGIN, { ...opts, gapMs: JI_GAP_MS });
    const listed = new Map<string, Obj>(); // by id: a job that moves between pages is counted once
    for (let n = 0, offset = 0; ; n++, offset += PAGE) {
      if (n >= JI_MAX_PAGES) throw new FetchFailedError(b.board, `more than ${JI_MAX_PAGES} pages`);
      const r = asObj(await call(`${JI_ORIGIN}/api/jobs?offset=${offset}&limit=${PAGE}`));
      const jobs = asArr(at(r, "data")).map(asObj);
      for (const j of jobs) {
        const id = asStr(at(j, "id"));
        if (!ID.test(id)) throw new FetchFailedError(b.board, "unsafe job id in the listing"); // it goes into the detail path
        if (!listed.has(id)) listed.set(id, j);
      }
      if (jobs.length === 0 || offset + PAGE >= asNum(at(r, "totalCount"))) break;
    }
    const today = (b.now ?? (() => new Date()))().toISOString().slice(0, 10);
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    let reads = 0;
    let limited = false;
    for (const [ext, j] of listed) {
      if (SCHEMES.has(str(get(j, "vacancyType"))) || jiLocation(j) === null || get(j, "active") === false || past(get(j, "dateClosed"), today)) continue;
      const id = `jobsireland:${b.board}:${ext}`;
      seen.push(id);
      if (known.has(id) || limited || reads >= b.maxDetails) continue;
      reads++;
      let d: unknown;
      try {
        d = await call(`${JI_ORIGIN}/api/jobs/${ext}`);
      } catch (e) {
        if (e instanceof FetchFailedError && RATE_LIMITED.test(e.message)) limited = true;
        continue;
      }
      const a = isObj(d) ? jiAdvert(b.board, ext, { ...j, ...d }, today) : null;
      if (a) adverts.push(a);
      else if (isObj(d)) seen.pop(); // past its closing date or no longer kept: a known one closes
    }
    return { seen, adverts };
  });
