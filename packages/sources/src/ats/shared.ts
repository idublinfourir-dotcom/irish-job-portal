// What the five ATS adapters share. Python: prototype/fetch_ats.py:5-11 (IRL, text), step0/run_day.py:135-144 (job, get_json).
import { FetchFailedError, type Fetch, type RawAdvert } from "../types";
import { HTML5, INVALID_CHARREFS, INVALID_CODEPOINTS } from "./entities";

// ---- Python whitespace -------------------------------------------------------------------------------------------
// Python's str.strip() and \s use str.isspace(); JavaScript's trim() and \s differ (\x1c-\x1f and \x85 only in Python,
// ﻿ only in JavaScript). This class is Python's set.
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");
export const pyStrip = (s: string) => s.replace(STRIP, "");

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
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json", "Content-Type": "application/json" }; // run_day.py:42
const SAFE_NAME = /^[A-Za-z0-9._-]+$/;

/** Board names go into a host name or a path: refuse anything that could change the host. */
export function safeName(board: string, ...names: string[]): void {
  for (const n of names) if (!SAFE_NAME.test(n)) throw new FetchFailedError(board, `unsafe board name ${JSON.stringify(n).slice(0, 40)}`);
}

export type Caller = (url: string, body?: unknown) => Promise<unknown>;

/**
 * A JSON caller that only talks to `origin`. Python requests follows redirects anywhere; here a redirect is followed only
 * to the same origin (and for POST only when the status keeps the method), at most 3 hops. Anything else is a failure.
 * Python: get_json (run_day.py:139-143) and the POST in f_workday.
 */
export function makeCaller(board: string, fetch: Fetch, origin: string): Caller {
  return async (url, body) => {
    const fail = (why: string, cause?: unknown) => new FetchFailedError(board, why, { cause });
    const method = body === undefined ? "GET" : "POST";
    for (let hop = 0; ; hop++) {
      if (new URL(url).origin !== origin) throw fail("refused: request to another host");
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers: HEADERS,
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
        if (!loc || !keeps || hop >= MAX_HOPS) throw fail(`HTTP ${res.status} redirect not followed`);
        url = new URL(loc, url).href; // the origin check at the top of the loop refuses another host
        continue;
      }
      if (!res.ok) throw fail(`HTTP ${res.status}`);
      try {
        if (Number(res.headers.get("content-length")) > MAX_BYTES) throw new Error("too large");
        const raw = await res.text();
        if (raw.length > MAX_BYTES) throw new Error("too large");
        return JSON.parse(raw) as unknown;
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
