// The LinkedIn guest-page source. Python: prototype/step0/run_day.py:354-420 (li_get, linkedin_batch, run_linkedin) and
// prototype/fetch_linkedin_lib.py (KEYWORDS, one). Unlike the ATS adapters it has state (the ids waiting for detail), and it
// owns no storage: the caller passes the waiting list in and gets the new list back (decision #143, Q8).
// Nothing here reads a global: fetch, sleep and random are passed in. No file, no database, no real timer.
import type { Fetch, RawAdvert } from "../types";
import { pyStrip, retryAfterMs } from "../ats/shared";
import { strip } from "./html";
import { TERM_GROUPS } from "./terms";

/** One row of the waiting list (Python table `linkedin_pending`, run_day.py:293). Dates are "YYYY-MM-DD". */
export type LinkedinPending = { id: string; term: string; group: string; firstSeen: string; lastSeen: string; done: boolean };

export type LinkedinOptions = {
  /** Decision #144, off when left out. On HTTP 429 only: wait, then try the same request again, at most `tries` times. */
  retry?: { tries: number; firstWaitMs: number; maxWaitMs?: number };
  /** Decision #144, off when left out. The most HTTP requests (redirect hops and retries included) one run may make. */
  maxRequests?: number;
};

export type LinkedinInput = {
  /** Every row from the last run, done ones included (a done id seen again must not be read again). */
  waiting: readonly LinkedinPending[];
  today: string;
  fetch: Fetch;
  sleep: (ms: number) => Promise<void>;
  /** Like Python's random.random(): a number from 0 up to but not including 1. */
  random: () => number;
  options?: LinkedinOptions;
  /** Which of the 44 terms to start the search at (default 0, as the Python always does). Pass back the last run's `searchNext` for a run on the same day. */
  searchFrom?: number;
};

export type LinkedinStop = {
  phase: "search" | "detail";
  /** "limit": LinkedIn said stop (429, 999, 403). "budget": maxRequests used up. "network": the request itself failed. */
  reason: "limit" | "budget" | "network";
  status: number | null;
  /** Python's text for fetch_log, e.g. "search stopped: status 429". */
  message: string;
};

export type LinkedinResult = {
  /** The new list: all input rows (done ones too) plus the ids found, in order. Hand it back as `waiting` next time. */
  waiting: LinkedinPending[];
  /** Every distinct id seen in a search this run, in order (run_day.py:386, the 7 day rule is the caller's). */
  seen: string[];
  /** Python's `seen`: ids summed over pages, so an id on two pages counts twice. */
  seenCount: number;
  adverts: RawAdvert[];
  stop: LinkedinStop | null;
  /** The index of the first term not yet searched: 44 when the search ran to its end. Kept as it was if the backlog rule skipped the search. A budget that ends in the search would otherwise start again at term 0 every time and never reach the details. */
  searchNext: number;
  /** HTTP requests made, redirect hops and retries included. */
  requests: number;
};

const TERMS = TERM_GROUPS.flatMap(([group, terms]) => terms.map((term) => [group, term] as const));
const ORIGIN = "https://www.linkedin.com";
const SEARCH = `${ORIGIN}/jobs-guest/jobs/api/seeMoreJobPostings/search`;
const DETAIL = `${ORIGIN}/jobs-guest/jobs/api/jobPosting/`;
const HEADERS = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36" }; // run_day.py:43
const TIMEOUT_MS = 30_000; // run_day.py:356
const DETAIL_CAP = 250; // run_day.py:39
const PAGES = 4; // run_day.py:40
const MAX_HOPS = 3;
const MAX_BYTES = 4 * 1024 * 1024; // a real page is 30 to 300 KB. Not in Python.
const MAX_IDS_PER_PAGE = 100; // a real page has 10. Not in Python.
const MAX_ID_LENGTH = 20; // a real id has 10 digits. Not in Python.
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const STOP_STATUSES = new Set([429, 999, 403]);
const ID_IN_PAGE = /jobPosting:(\d+)/g; // ASCII digits only. Python's \d also takes other scripts' digits; an id goes into a URL.
const ID_OK = /^\d{1,20}$/;

/** run_day.py:388-390, the URL as built there: only spaces are escaped (a known quirk). */
export const searchUrl = (term: string, start: number) => `${SEARCH}?keywords=${term.replaceAll(" ", "%20")}&location=Ireland&start=${start}`;

class Halt extends Error {
  constructor(
    readonly reason: LinkedinStop["reason"],
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

// ---- reading one detail page ----------------------------------------------------------------------------------------
/**
 * Python `one(rx, s)` (fetch_linkedin_lib.py:28-29) for the shapes used: `open [^>]* > (.*?) close` when `gap`, else
 * `open (.*?) close` with the ">" inside `open`. re.search takes the first match, and if the first `open` has no `close`
 * after it no later one has, so indexOf finds the same text in one pass (a regular expression would be quadratic on a
 * hostile page with many `open` and no `close`).
 */
function one(open: string, gap: boolean, close: string, s: string): string {
  const i = s.indexOf(open);
  if (i < 0) return "";
  let from = i + open.length;
  if (gap) {
    from = s.indexOf(">", from);
    if (from < 0) return "";
    from++;
  }
  const end = s.indexOf(close, from);
  return end < 0 ? "" : strip(s.slice(from, end));
}

/**
 * `re.findall(open [^>]* > \s* ([^<]+?) \s* <)` (run_day.py:403). The text up to the next "<", trimmed with Python's \s; if it is all
 * white space the group is its last character (the regex backtracks one character); if it is empty the occurrence gives nothing.
 * Not HTML-unescaped, as in Python.
 */
function findAll(d: string, open: string, gap: boolean): string[] {
  const out: string[] = [];
  let pos = 0;
  for (;;) {
    const i = d.indexOf(open, pos);
    if (i < 0) return out;
    let from = i + open.length;
    if (gap) {
      from = d.indexOf(">", from);
      if (from < 0) return out;
      from++;
    }
    const lt = d.indexOf("<", from);
    if (lt < 0) return out;
    const raw = d.slice(from, lt);
    if (raw === "") {
      pos = gap ? from : i + 1; // with a gap every earlier occurrence ends at the same ">" and fails the same way
      continue;
    }
    const t = pyStrip(raw); // Python's \s, not JavaScript's
    out.push(t === "" ? raw.slice(-1) : t);
    pos = lt + 1;
  }
}

/** run_day.py:403-410. `id` must be digits (the caller checks). */
export function parseLinkedinDetail(id: string, d: string): RawAdvert {
  const keys = findAll(d, 'description__job-criteria-subheader">', false);
  const values = findAll(d, "description__job-criteria-text", true);
  const crit = new Map<string, string>();
  for (let i = 0; i < Math.min(keys.length, values.length); i++) crit.set(keys[i]!, values[i]!); // zip, then dict: the last duplicate wins
  // job() in run_day.py:135-137
  return {
    id: `linkedin:ie:${id}`,
    source: "linkedin",
    board: "ie",
    employer: one("topcard__org-name-link", true, "</a>", d) || one('topcard__flavor">', false, "</span>", d),
    title: one("topcard__title", true, "</h2>", d), // already stripped by one()
    location: one('topcard__flavor topcard__flavor--bullet">', false, "</span>", d),
    description: one("show-more-less-html__markup", true, "</div>", d),
    url: `${ORIGIN}/jobs/view/${id}`,
    employmentType: crit.get("Employment type") ?? "",
    salaryBox: one('compensation__salary">', false, "</div>", d),
  };
}

// ---- the run ------------------------------------------------------------------------------------------------------
export async function runLinkedin(input: LinkedinInput): Promise<LinkedinResult> {
  const { fetch, sleep, random, today } = input;
  const { retry, maxRequests } = input.options ?? {};
  const rows = new Map<string, LinkedinPending>(input.waiting.map((r) => [r.id, { ...r }]));
  const seen = new Set<string>();
  const adverts: RawAdvert[] = [];
  let seenCount = 0;
  let requests = 0;

  /** One request. Redirects are followed only inside www.linkedin.com, 3 hops at most; any other 3xx is returned as it is. */
  async function once(url: string): Promise<Response> {
    for (let hop = 0; ; hop++) {
      if (maxRequests !== undefined && requests >= maxRequests) throw new Halt("budget", null, "request budget used up");
      requests++;
      let res: Response;
      try {
        res = await fetch(url, { headers: HEADERS, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch {
        throw new Halt("network", null, "request failed");
      }
      if (res.status < 300 || res.status >= 400 || hop >= MAX_HOPS) return res;
      try {
        const next = new URL(res.headers.get("location") ?? "", url);
        if (next.origin !== ORIGIN) return res;
        url = next.href;
      } catch {
        return res;
      }
    }
  }

  /** The wait before a retry: Retry-After (seconds, or a date counted from the response's own Date header) if it gives a wait above zero, else double each time. */
  function waitMs(res: Response, attempt: number, r: NonNullable<LinkedinOptions["retry"]>): number {
    let ms = retryAfterMs(res);
    if (!(ms > 0)) ms = r.firstWaitMs * 2 ** attempt;
    return Math.min(ms, r.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);
  }

  /** Python li_get (run_day.py:354-361): the text on 200, "" on any other answer, Halt on a stop answer. */
  async function get(url: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const res = await once(url);
      if (res.status === 429 && retry && attempt < retry.tries) {
        await sleep(waitMs(res, attempt, retry));
        continue;
      }
      if (STOP_STATUSES.has(res.status)) throw new Halt("limit", res.status, `status ${res.status}`);
      if (res.status !== 200) return "";
      try {
        if (Number(res.headers.get("content-length")) > MAX_BYTES) return "";
        const t = await res.text();
        return t.length > MAX_BYTES ? "" : t;
      } catch {
        throw new Halt("network", null, "request failed");
      }
    }
  }

  // run_day.py:381-392
  async function search(): Promise<void> {
    for (; searchNext < TERMS.length; searchNext++) {
      const [group, term] = TERMS[searchNext]!;
      let got = 0;
      for (let page = 0; page < PAGES; page++) {
        const t = await get(searchUrl(term, got));
        const ids = new Set<string>();
        for (const m of t.matchAll(ID_IN_PAGE)) {
          if (m[1]!.length <= MAX_ID_LENGTH) ids.add(m[1]!);
          if (ids.size >= MAX_IDS_PER_PAGE) break;
        }
        if (!ids.size) break;
        got += ids.size;
        for (const id of ids) {
          const row = rows.get(id);
          if (row) row.lastSeen = today; // on conflict: only last_seen changes (run_day.py:387-388)
          else rows.set(id, { id, term, group, firstSeen: today, lastSeen: today, done: false });
          seen.add(id);
        }
        seenCount += ids.size;
        await sleep(1500 + random() * 1000);
      }
    }
  }

  // run_day.py:364-372: one from each group in turn, at random inside a group, at most DETAIL_CAP.
  function batch(): LinkedinPending[] {
    const byGroup = new Map<string, LinkedinPending[]>();
    for (const r of rows.values()) if (!r.done) (byGroup.get(r.group) ?? byGroup.set(r.group, []).get(r.group)!).push(r);
    const turns: { turn: number; group: string; row: LinkedinPending }[] = [];
    for (const [group, list] of byGroup) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j]!, list[i]!];
      }
      list.forEach((row, turn) => turns.push({ turn, group, row }));
    }
    turns.sort((a, b) => a.turn - b.turn || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
    return turns.slice(0, DETAIL_CAP).map((t) => t.row);
  }

  // run_day.py:397-413
  async function details(): Promise<void> {
    for (const p of batch()) {
      if (!ID_OK.test(p.id)) {
        p.done = true; // an id that is not plain digits is never put in a URL
        continue;
      }
      await sleep(1200 + random() * 1000);
      const d = await get(DETAIL + p.id);
      p.done = true; // known quirk: marked done before the page is read, so a page that answers badly is never tried again
      if (d) adverts.push(parseLinkedinDetail(p.id, d));
    }
  }

  let searchNext = Number.isInteger(input.searchFrom) && input.searchFrom! > 0 ? input.searchFrom! : 0;
  let stop: LinkedinStop | null = null;
  const halted = (phase: LinkedinStop["phase"], e: unknown): LinkedinStop => {
    if (!(e instanceof Halt)) throw e;
    return { phase, reason: e.reason, status: e.status, message: `${phase} stopped: ${e.message}` };
  };
  // Searches use the same limit as details, so a big backlog is cleared before searching again (run_day.py:379).
  const backlog = [...rows.values()].filter((r) => !r.done).length;
  try {
    if (backlog <= DETAIL_CAP) await search();
  } catch (e) {
    stop = halted("search", e); // known quirk: a stop in the search means no advert is read this run
  }
  if (!stop) {
    try {
      await details();
    } catch (e) {
      stop = halted("detail", e);
    }
  }
  return { waiting: [...rows.values()], seen: [...seen], seenCount, adverts, stop, searchNext, requests };
}
