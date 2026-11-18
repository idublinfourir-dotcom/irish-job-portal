// W1c: seven Workday employers read from their own career sites, because Workday's Cloudflare challenges every data-centre address.
// Research: step15/w1c-careersites.md. Three kinds: `phenom` (the site's own search call, then each new job's page), `sitemap` (the
// sitemap, then each new job's page) and `salesforce` (one file with every job and its text). Pages are read for their JSON-LD JobPosting.
// Every id is the employer's requisition id, the same one Workday shows, so the Workday rows can be moved over (db/src/workday-move.ts).
import { FetchFailedError, type BoardFetch, type SourceAdapter } from "../types";
import type { SlugBoard } from "../ats/adapters";
import { MAX_PAGES, PACE, RATE_LIMITED, asArr, asNum, asObj, asStr, at, get, guard, htmlUnescape, isObj, job, makeCaller, safeName, text, type Caller, type Obj } from "../ats/shared";

const objs = (v: unknown) => asArr(v).map(asObj);
const str = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const SAFE_ID = /^[A-Za-z0-9._-]{1,100}$/;

// ---- JSON-LD JobPosting --------------------------------------------------------------------------------------------
const MAX_BLOCKS = 20; // ld+json blocks read on one page; the sites have 1 to 4
// Fidelity writes the type as application/ld&#x2B;json, so the attributes are decoded before the match.
const LD_TYPE = /\btype\s*=\s*["']?application\/ld\+json/i;
const isPosting = (o: Obj) => [get(o, "@type")].flat().includes("JobPosting");

/** The first JSON-LD JobPosting of a page, or null. Reads at most MAX_BLOCKS ld+json blocks; a block that is not JSON is passed over. Pure. */
export function jobPosting(html: string): Obj | null {
  // a search for each tag in turn, not one regular expression over the page: an unclosed "<script" must not make the scan quadratic
  const open = /<script\b/gi;
  const close = /<\/script\s*>/gi;
  for (let blocks = 0; blocks < MAX_BLOCKS && open.exec(html); ) {
    const gt = html.indexOf(">", open.lastIndex);
    if (gt < 0) return null;
    close.lastIndex = gt + 1;
    const end = close.exec(html);
    if (!end) return null;
    const attrs = html.slice(open.lastIndex, gt);
    open.lastIndex = close.lastIndex;
    if (!LD_TYPE.test(htmlUnescape(attrs))) continue;
    blocks++;
    let v: unknown;
    try {
      v = JSON.parse(html.slice(gt + 1, end.index));
    } catch {
      continue;
    }
    for (const o of [v].flat()) {
      if (!isObj(o)) continue;
      if (isPosting(o)) return o;
      const graph = get(o, "@graph");
      const hit = Array.isArray(graph) ? graph.find((g) => isObj(g) && isPosting(g)) : undefined;
      if (hit) return hit as Obj;
    }
  }
  return null;
}

const IRISH_COUNTRY = new Set(["ireland", "ie", "irl", "republic of ireland"]);
export type Posting = { id: string; title: string; description: string; datePosted: string; location: string; irish: boolean; employmentType: string; url: string };

/** The fields the fetcher keeps. `irish`: one of the places has an Irish addressCountry; `location` lists those places only. Pure. */
export function readPosting(o: Obj): Posting {
  const ident = get(o, "identifier");
  const irish = [get(o, "jobLocation")].flat().slice(0, 50).flatMap((p) => {
    const a = isObj(p) ? get(p, "address") : undefined;
    const c = isObj(a) ? get(a, "addressCountry") : undefined;
    return isObj(a) && IRISH_COUNTRY.has(str(isObj(c) ? get(c, "name") : c).toLowerCase()) ? [[text(str(get(a, "addressLocality"))), "Ireland"].filter(Boolean).join(", ")] : [];
  });
  // Phenom sends the description HTML escaped once more (&lt;p&gt;): unescape it once so text() finds the tags
  const d = str(get(o, "description"));
  return {
    id: str(isObj(ident) ? get(ident, "value") : ident),
    title: text(str(get(o, "title"))),
    description: text(d.includes("<") ? d : htmlUnescape(d)),
    datePosted: str(get(o, "datePosted")),
    location: [...new Set(irish)].join(" / "),
    irish: irish.length > 0,
    employmentType: [get(o, "employmentType")].flat().map(str).filter(Boolean).join(", "),
    url: str(get(o, "url")),
  };
}

/** One job page's posting. A page that fails or has no JobPosting is null; a refusal for the rate limit fails the board. */
async function page(call: Caller, url: string): Promise<Posting | null> {
  try {
    const o = jobPosting(asStr(await call(url)));
    return o ? readPosting(o) : null;
  } catch (e) {
    if (e instanceof FetchFailedError && RATE_LIMITED.test(e.message)) throw e;
    return null;
  }
}

/** The board's own site: https, no path. A path is /a/b with plain segments. */
function checkSite(board: string, origin: string, ...paths: string[]) {
  let ok = false;
  try {
    ok = origin.startsWith("https://") && new URL(origin).origin === origin;
  } catch {
    // ok stays false
  }
  // plain segments; no "." or ".." segment, no "//"
  if (!ok || paths.some((p) => !/^(\/(?!\.\.?(?:\/|$))[A-Za-z0-9._-]+)*\/?$/.test(p))) throw new FetchFailedError(board, "bad board site or path");
}

// ---- Phenom ----------------------------------------------------------------------------------------------------------
export type PhenomBoard = { employer: string; board: string; origin: string; lang: string; country: string; pageId: string; path: string };
const PAGE_SIZE = 50;
// The body the sites' own search page sends (phApp.ddo on /search-results), with the Ireland filter.
const phenomBody = (b: PhenomBoard, from: number) => ({
  lang: b.lang, deviceType: "desktop", country: b.country, pageName: "search-results", ddoKey: "refineSearch", sortBy: "", subsearch: "", from, jobs: true, counts: true,
  all_fields: ["category", "country", "state", "city", "type"], size: PAGE_SIZE, clearAll: false, jdsource: "facets", isSliderEnable: false, pageId: b.pageId,
  siteType: "external", keywords: "", global: true, selected_fields: { country: ["Ireland"] }, sort: { order: "desc", field: "postedDate" }, locationData: {},
});
const slug = (t: string) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "job";

/**
 * POST /widgets pages of 50 with the Ireland filter until totalHits, then one page per job not in `known`. The filter also matches jobs that
 * list Ireland among many places: a job whose listed country is another one is dropped before its page, and a job whose JobPosting has no
 * Irish place is dropped after it. A page that fails counts the job as seen (nothing closes on a bad page) but saves nothing.
 */
export const fetchPhenom: SourceAdapter<PhenomBoard> = (b, known, fetch, opts) =>
  guard(b.board, async () => {
    safeName(b.board, b.board, b.lang, b.country, b.pageId);
    checkSite(b.board, b.origin, b.path);
    const call = makeCaller(b.board, fetch, b.origin, { ...opts, gapMs: PACE.siteCallGapMs, text: true });
    const listed = new Map<string, Obj>(); // by reqId: a job that moves between pages is counted once
    for (let n = 0, from = 0; ; n++, from += PAGE_SIZE) {
      if (n >= MAX_PAGES) throw new FetchFailedError(b.board, `more than ${MAX_PAGES} pages`);
      const rs = asObj(at(asObj(JSON.parse(asStr(await call(`${b.origin}/widgets`, phenomBody(b, from))))), "refineSearch"));
      const jobs = objs(at(asObj(at(rs, "data")), "jobs"));
      for (const j of jobs) listed.set(asStr(at(j, "reqId")), j);
      if (jobs.length === 0 || from + PAGE_SIZE >= asNum(at(rs, "totalHits"))) break;
    }
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (const [reqId, j] of listed) {
      if (!SAFE_ID.test(reqId)) throw new FetchFailedError(b.board, "unsafe job id in the listing"); // it goes into a page path
      const country = get(j, "country");
      if (typeof country === "string" && country !== "Ireland") continue;
      const id = `phenom:${b.board}:${reqId}`;
      seen.push(id);
      if (known.has(id)) continue;
      const url = `${b.origin}${b.path}/job/${reqId}/${slug(str(get(j, "title")))}`;
      const p = await page(call, url);
      if (!p) continue;
      if (!p.irish) {
        seen.pop();
        continue;
      }
      adverts.push(job("phenom", b.board, reqId, b.employer, p.title, p.location, p.description, url, p.employmentType));
    }
    return { seen, adverts };
  });

// ---- Sitemap ---------------------------------------------------------------------------------------------------------
/** `pattern` keeps the Irish job URLs (its first group is the id when `idFrom` is "url"). "page": the id is the JobPosting's identifier (Citi's URL number is not the Workday id), so every Irish page is read each run. */
export type SitemapBoard = { employer: string; board: string; origin: string; sitemap: string; pattern: string; idFrom: "url" | "page" };
export const MAX_SITEMAPS = 20; // files under one index
export const MAX_URLS = 100_000; // all files together (the protocol allows 50,000 a file; Citi has about 7,000)
const LOC = /<loc>([^<]*)<\/loc>/g;

/** Every URL of a sitemap or of a sitemap index (one level: an index inside an index is refused). Over the caps the board fails. */
async function sitemapUrls(board: string, call: Caller, url: string): Promise<string[]> {
  const urls: string[] = [];
  const locs = (xml: string, cap: number, what: string) => {
    const out: string[] = [];
    for (const m of xml.matchAll(LOC)) if (out.push(htmlUnescape(m[1]!).trim()) > cap) throw new FetchFailedError(board, `sitemap has more than ${cap} ${what}`);
    return out;
  };
  const root = asStr(await call(url));
  const files = /<sitemapindex[\s>]/.test(root) ? locs(root, MAX_SITEMAPS, "files") : null;
  for (const xml of files ? [] : [root]) urls.push(...locs(xml, MAX_URLS, "URLs"));
  for (const f of files ?? []) {
    const xml = asStr(await call(f)); // another host is refused by the caller, and the board fails
    if (/<sitemapindex[\s>]/.test(xml)) throw new FetchFailedError(board, "sitemap index inside a sitemap index");
    urls.push(...locs(xml, MAX_URLS - urls.length, "URLs"));
  }
  return urls;
}

export const fetchSitemap: SourceAdapter<SitemapBoard> = (b, known, fetch, opts) =>
  guard(b.board, async () => {
    safeName(b.board, b.board);
    checkSite(b.board, b.origin, b.sitemap);
    const call = makeCaller(b.board, fetch, b.origin, { ...opts, gapMs: PACE.siteCallGapMs, text: true });
    const re = new RegExp(b.pattern);
    const seen = new Set<string>();
    const adverts: BoardFetch["adverts"] = [];
    const add = (ext: string, p: Posting, url: string) => {
      const id = `sitemap:${b.board}:${ext}`;
      if (!seen.has(id) && !known.has(id)) adverts.push(job("sitemap", b.board, ext, b.employer, p.title, p.location, p.description, url, p.employmentType));
      seen.add(id);
    };
    for (const url of new Set((await sitemapUrls(b.board, call, b.origin + b.sitemap)).filter((u) => u.startsWith(b.origin + "/") && re.test(u)))) {
      if (b.idFrom === "page") {
        // ponytail: a page that fails leaves its job unseen here, so a known job closes and comes back on the next good read
        const p = await page(call, url);
        if (p?.irish && SAFE_ID.test(p.id)) add(p.id, p, url);
        continue;
      }
      const ext = re.exec(url)?.[1] ?? "";
      if (!SAFE_ID.test(ext)) continue;
      const id = `sitemap:${b.board}:${ext}`;
      if (known.has(id) || seen.has(id)) {
        seen.add(id);
        continue;
      }
      const p = await page(call, url);
      if (!p) seen.add(id); // a page that fails closes nothing
      else if (p.irish) add(ext, p, url);
    }
    return { seen: [...seen], adverts };
  });

// ---- Salesforce ------------------------------------------------------------------------------------------------------
// The file the careers site's own page loads: every job (about 1,600, 11 MB) with its full text. No page calls.
export const SALESFORCE_JOBS = "https://a.sfdcstatic.com/digital/xsf/careers/prod/jobs_2.json";

export const fetchSalesforce: SourceAdapter<SlugBoard> = ({ slug: board, employer }, known, fetch, opts) =>
  guard(board, async () => {
    const call = makeCaller(board, fetch, "https://a.sfdcstatic.com", opts);
    const seen: string[] = [];
    const adverts: BoardFetch["adverts"] = [];
    for (const r of objs(at(asObj(await call(SALESFORCE_JOBS)), "Report_Entry"))) {
      if (!asArr(get(r, "Countries", [])).includes("Ireland")) continue;
      const ref = asStr(at(r, "Job_Requisition_Ref_ID"));
      const id = `salesforce:${board}:${ref}`;
      seen.push(id);
      if (known.has(id)) continue;
      adverts.push(job("salesforce", board, ref, employer, get(r, "Job_Posting_Title"), get(r, "Job_Requisition_Primary_Location"), text(get(r, "Job_Description")), get(r, "External_Job_Posting_Site"), get(r, "Time_Type")));
    }
    return { seen, adverts };
  });
