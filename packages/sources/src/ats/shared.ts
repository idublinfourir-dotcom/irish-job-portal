// What the five ATS adapters share. Python: prototype/fetch_ats.py:5-11 (IRL, text), step0/run_day.py:135-144 (job, get_json).
import { FetchFailedError, type Fetch, type RawAdvert } from "../types";
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./entities";

// ---- Python whitespace -------------------------------------------------------------------------------------------
// Python's str.strip() and \s use str.isspace(); JavaScript's trim() and \s differ (\x1c-\x1f and \x85 only in Python,
// ﻿ only in JavaScript). This class is Python's set.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"; // for the blank line pattern in text()
// A loop, not a regular expression: `^[ws]+|[ws]+$` takes quadratic time on a long run of white space inside the text
// ("a" + 80,000 spaces + "b" took 4.8 s), and titles and descriptions are untrusted.
const isWs = (c: number) => c === 32 || (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x1f) || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
export function pyStrip(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && isWs(s.charCodeAt(a))) a++;
  while (b > a && isWs(s.charCodeAt(b - 1))) b--;
  return s.slice(a, b);
}

// ---- html.unescape -----------------------------------------------------------------------------------------------
// Port of CPython Lib/html/__init__.py (unescape and _replace_charref). Maps, not objects: "constructor" is not an entity.
const named = new Map(Object.entries(HTML5));
const invalidRefs = new Map(Object.entries(INVALID_CHARREFS).map(([k, v]) => [Number(k), v]));
const invalidCodepoints = new Set(INVALID_CODEPOINTS);
const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;

function charref(_m: string, s: string): string {
  if (s.startsWith("#")) {
    // ponytail: Python 3.11+ raises ValueError for more than 4300 digits; here a huge number is just U+FFFD.
    const num = /^#[xX]/.test(s) ? parseInt(s.slice(2).replace(/;$/, ""), 16) : parseInt(s.slice(1).replace(/;$/, ""), 10);
    const repl = invalidRefs.get(num);
    if (repl !== undefined) return repl;
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return "�";
    if (invalidCodepoints.has(num)) return "";
    return String.fromCodePoint(num);
  }
  const whole = named.get(s);
  if (whole !== undefined) return whole;
  // longest matching name without its semicolon (the HTML standard's rule)
  for (let x = s.length - 1; x > 1; x--) {
    const hit = named.get(s.slice(0, x));
    if (hit !== undefined) return hit + s.slice(x);
  }
  return "&" + s;
}
export const htmlUnescape = (s: string) => (s.includes("&") ? s.replace(CHARREF, charref) : s);

// ---- text() ------------------------------------------------------------------------------------------------------
// Python: fetch_ats.py:7-11. Two of its regular expressions (a tag with no closing ">") are quadratic in Python and
// would hang on a hostile "<<<<<..." body, so they are replaced here by a scan that gives the same result in one pass.
const BREAK_TAG = /(?:br|\/p|\/l[iı]|\/h\p{Nd}|\/d[iı]v)/iuy; // [iı]: Python's re.I also folds dotless i
function replaceTags(h: string, replacement: string, prefix: RegExp | null): string {
  let out = "";
  let from = 0; // start of the text not yet copied
  let i = h.indexOf("<");
  while (i >= 0) {
    let bodyStart = i + 1;
    if (prefix) {
      prefix.lastIndex = i + 1;
      if (!prefix.test(h)) {
        i = h.indexOf("<", i + 1);
        continue;
      }
      bodyStart = prefix.lastIndex;
    }
    const gt = h.indexOf(">", bodyStart);
    // no ">" after this point: no later "<" can match either
    if (gt < 0) break;
    // without a prefix the body is [^>]+, so it needs at least one character
    if (!prefix && gt === i + 1) {
      i = h.indexOf("<", i + 1);
      continue;
    }
    out += h.slice(from, i) + replacement;
    from = gt + 1;
    i = h.indexOf("<", from);
  }
  return out + h.slice(from);
}

export function text(h: unknown): string {
  let t = htmlUnescape(asStr(or(h, "")));
  t = replaceTags(t, "\n", BREAK_TAG); // <(br|/p|/li|/h\d|/div)[^>]*>  -> "\n"
  t = replaceTags(t, " ", null); //       <[^>]+>                        -> " "
  t = t.replace(new RegExp(`\\n[${WS}]*\\n+`, "gu"), "\n");
  return pyStrip(t.replace(/[ \t]+/g, " "));
}

// ---- Irish location filter ---------------------------------------------------------------------------------------
// Python: fetch_ats.py:5. \b in Python is Unicode-aware (a letter or digit next to the word is not a boundary), so the
// boundary is written out; [iı] because Python's re.I treats dotless i as i.
const W = "[\\p{L}\\p{N}_]";
const PLACES =
  "ireland|dublin|cork|galway|limerick|shannon|waterford|kildare|meath|wicklow|athlone|sligo|kinsale|leixlip|clonmel|letterkenny|drogheda|dundalk|kilkenny|wexford|carlow|tralee|ennis|naas|swords|blanchardstown|sandyford";
const IRL = new RegExp(`(?<!${W})(?:${PLACES.replaceAll("i", "[iı]")})(?!${W})`, "iu");
export const isIrish = (loc: string) => IRL.test(loc);

// ---- Python-shaped reading of untrusted JSON ---------------------------------------------------------------------
// The Python reads with dict.get, `or` and indexing, and any exception makes the whole board "failed" (run_day.py:332-337).
// These helpers throw where Python would raise (KeyError, TypeError, AttributeError); the adapters wrap them once.
export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
export function asObj(v: unknown): Obj {
  if (!isObj(v)) throw new TypeError("expected an object");
  return v;
}
export function asArr(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new TypeError("expected a list");
  return v;
}
export function asStr(v: unknown): string {
  if (typeof v !== "string") throw new TypeError("expected a string");
  return v;
}
export function asNum(v: unknown): number {
  if (typeof v !== "number") throw new TypeError("expected a number");
  return v;
}
/** Python `o[k]`. */
export function at(o: Obj, k: string): unknown {
  if (!Object.hasOwn(o, k)) throw new TypeError(`missing key ${k}`);
  return o[k];
}
/** Python `o.get(k, d)`: the default only when the key is missing (null stays null). */
export const get = (o: Obj, k: string, d?: unknown): unknown => (Object.hasOwn(o, k) ? o[k] : d);
/** Python truthiness. */
export const truthy = (v: unknown): boolean =>
  !(v === null || v === undefined || v === false || v === 0 || v === "" || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.keys(v).length === 0));
/** Python `v or d`. */
export const or = (v: unknown, d: unknown): unknown => (truthy(v) ? v : d);
/** Python f"{v}" for the JSON scalars an id can be. */
export const pyStr = (v: unknown): string => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : String(v));

/** run_day.py:139-143 `job`. `desc`, `loc`, `url`, `etype` and `box` go through `x or ""` as in Python. */
export function job(source: string, board: string, extId: unknown, employer: string, title: unknown, loc: unknown, desc: unknown, url: unknown, etype?: unknown, box?: unknown): RawAdvert {
  return {
    id: `${source}:${board}:${pyStr(extId)}`,
    source,
    board,
    employer,
    title: pyStrip(asStr(or(title, ""))),
    location: asStr(or(loc, "")),
    description: asStr(or(desc, "")),
    url: asStr(or(url, "")),
    employmentType: asStr(or(etype, "")),
    salaryBox: asStr(or(box, "")),
  };
}

// ---- The one place that calls fetch --------------------------------------------------------------------------------
const TIMEOUT_MS = 45_000; // run_day.py:140 timeout=45
const MAX_BYTES = 32 * 1024 * 1024; // ponytail: whole body read into memory; the 45 s timeout bounds a slow sender. Stream with a cap if bodies near this size appear.
const MAX_HOPS = 3;
// An honest name, not a browser's (W1, 18 Nov 2026: Workday's Cloudflare limit answered 429 to a bare "Mozilla/5.0").
const HEADERS = {
  "User-Agent": "IrishWorkPermitJobs/1.0 (job listing fetcher; +https://irishworkpermit.ie)",
  Accept: "application/json",
  "Accept-Language": "en-IE,en;q=0.9",
  "Content-Type": "application/json",
};
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** How gently the fetch talks to the boards (W1). Every wait and pause of the fetch is set here. */
export const PACE = {
  tries: 3, // per call, on HTTP 429 or 503
  backoffMs: [5_000, 15_000], // the wait before try 2 and try 3 when Retry-After gives no usable wait
  maxWaitMs: 60_000, // any one wait, whatever Retry-After says
  boardWaitMs: 90_000, // all waits of one board
  runWaitMs: 180_000, // all waits of one run, every board together
  workdayCallGapMs: 300, // between two calls of one Workday board
  serialBoardGapMs: 1_500, // between two boards that run one at a time (Workday)
  siteCallGapMs: 2_000, // between two calls of one employer's own career site (W1c: Phenom, sitemap)
  giveUpAfter: 2, // this many serial boards in a row giving up on 429/503 skip the rest of them for the run
};
export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The wait budget of a whole run, shared by every board's caller. */
export const runBudget = () => ({ leftMs: PACE.runWaitMs });
/** A failure that came from HTTP 429 or 503 after the retries: the serial lane counts these. */
export const RATE_LIMITED = /^HTTP (429|503)\b/;

/** Board names go into a host name or a path: refuse anything that could change the host. */
export function safeName(board: string, ...names: string[]): void {
  for (const n of names) if (!SAFE_NAME.test(n)) throw new FetchFailedError(board, `unsafe board name ${JSON.stringify(n).slice(0, 40)}`);
}

export type Caller = (url: string, body?: unknown) => Promise<unknown>;
/** `text`: the caller returns the body as text (a page, a sitemap), not parsed JSON. */
export type CallerOptions = { sleep?: Sleep; gapMs?: number; budget?: { leftMs: number }; text?: boolean };

/** Where a refused redirect pointed, for the log: no query, fragment or credentials (they can carry a token), at most 120 characters. */
function target(loc: string, base: string): string {
  try {
    const u = new URL(loc, base);
    u.username = u.password = u.search = u.hash = "";
    return u.href.slice(0, 120);
  } catch {
    return "an unreadable address";
  }
}

const HTTP_DATE = /^[A-Za-z]{3}, \d\d [A-Za-z]{3} \d{4} \d\d:\d\d:\d\d GMT$/;
/** Retry-After in ms (seconds, or a date counted from the response's own Date header); NaN when missing or unreadable. May be 0 or negative. */
export function retryAfterMs(res: Response): number {
  const h = (res.headers.get("retry-after") ?? "").trim();
  if (/^\d{1,9}$/.test(h)) return Number(h) * 1000;
  if (HTTP_DATE.test(h)) return Date.parse(h) - Date.parse(res.headers.get("date") ?? "");
  return NaN;
}

/** Untrusted text for a log line: control, format and line-separator characters become a space, at most `n` code points. */
export const clip = (s: string, n: number) => [...s.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")].slice(0, n).join("");

/** What a refusing server said, for the failure text: a few headers and the start of the body. Reads one chunk of the body at most. */
async function said(res: Response): Promise<string> {
  const h = ["retry-after", "cf-ray", "cf-mitigated", "server"].flatMap((k) => (res.headers.has(k) ? [`${k} ${clip(res.headers.get(k)!, 60)}`] : []));
  let body = "";
  try {
    const reader = res.body?.getReader();
    if (reader) {
      const { value } = await reader.read();
      void reader.cancel().catch(() => {});
      body = clip(new TextDecoder().decode(value?.subarray(0, 1024)), 200).trim();
    }
  } catch {
    // the body is only for the log
  }
  return `${h.length ? ` (${h.join("; ")})` : ""}${body ? `: ${body}` : ""}`;
}

/**
 * A JSON caller that only talks to `origin`. Python requests follows redirects anywhere; here a redirect is followed only
 * to the same origin (and for POST only when the status keeps the method), at most 3 hops. Anything else is a failure.
 * HTTP 429 or 503 is tried again (PACE.tries in all) after Retry-After or the backoff, within the board's and the run's wait budget.
 * `gapMs` is a pause before every call but the first. Python: get_json (run_day.py:139-143) and the POST in f_workday.
 */
export function makeCaller(board: string, fetch: Fetch, origin: string, { sleep = realSleep, gapMs = 0, budget = runBudget(), text: asText = false }: CallerOptions = {}): Caller {
  const headers = asText ? { ...HEADERS, Accept: "text/html, application/xml;q=0.9, */*;q=0.8" } : HEADERS;
  let calls = 0;
  let boardLeft = PACE.boardWaitMs;
  return async (url, body) => {
    const fail = (why: string, cause?: unknown) => new FetchFailedError(board, why, { cause });
    const method = body === undefined ? "GET" : "POST";
    if (calls++ && gapMs) await sleep(gapMs);
    for (let hop = 0, tries = 1; ; hop++) {
      if (new URL(url).origin !== origin) throw fail("refused: request to another host");
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: method === "POST" ? JSON.stringify(body) : undefined,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        throw fail(`request failed: ${e instanceof Error ? e.name : "error"}`, e);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        const keeps = method === "GET" || res.status === 307 || res.status === 308;
        if (!loc || !keeps || hop >= MAX_HOPS) throw fail(`HTTP ${res.status} redirect${loc ? ` to ${target(loc, url)}` : ""} not followed`);
        url = new URL(loc, url).href; // the origin check at the top of the loop refuses another host
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const asked = retryAfterMs(res);
        const wait = Math.min(asked > 0 ? asked : PACE.backoffMs[tries - 1]!, PACE.maxWaitMs);
        // the same request again (a redirect hop is not a try); give up when the tries or either budget run out
        if (tries < PACE.tries && wait <= boardLeft && wait <= budget.leftMs) {
          void res.body?.cancel().catch(() => {});
          boardLeft -= wait;
          budget.leftMs -= wait;
          await sleep(wait);
          tries++;
          hop--;
          continue;
        }
      }
      if (!res.ok) throw fail(`HTTP ${res.status}${tries > 1 ? ` after ${tries} tries` : ""}${await said(res)}`);
      try {
        if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error("too large");
        const raw = await res.text();
        if (raw.length > MAX_BYTES) throw new Error("too large");
        return asText ? raw : (JSON.parse(raw) as unknown);
      } catch (e) {
        throw fail(e instanceof Error && e.message === "too large" ? "body too large" : "body is not JSON", e);
      }
    }
  };
}

/** Runs an adapter body; every error that is not already typed becomes the typed one (run_day.py:332-337 catches all). */
export async function guard<T>(board: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof FetchFailedError) throw e;
    throw new FetchFailedError(board, `unexpected response shape: ${e instanceof Error ? e.message : "error"}`, { cause: e });
  }
}

/** Paging limit for sources where Python pages until the server's own total: a lying total must not run for ever. */
export const MAX_PAGES = 50;
