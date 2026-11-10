// Helpers that make JavaScript text handling behave like Python's `re` and `str` for the rules in this lane.
// Why: Python's \b, \d, \s and case folding are Unicode-aware, JavaScript's are not (PORT-MAP F6).

// Python's str.split() / str.strip() whitespace (str.isspace): differs from JS \s at \x1c-\x1f, \x85 (Python only) and ﻿ (JS only).
const WS = String.raw`\t\n\v\f\r \x1c-\x1f\x85\xa0  -     　`;
// Python word characters: letters, numbers, underscore (marks are not word characters).
const WORD = String.raw`\p{L}\p{N}_`;
const BOUND_START = `(?<![${WORD}])`;
const BOUND_END = `(?![${WORD}])`;

/**
 * Build a JS regex from Python pattern text. Handled: \b (as a start or end boundary, by position),
 * \d, \s, and, with flag "i", Python's extra match of dotless and dotted I against "i".
 * Not handled (not used by these rules): \w, \B, escapes inside [...]. Always adds the `u` flag.
 */
export function pyRegex(src: string, flags = ""): RegExp {
  const ignoreCase = flags.includes("i");
  let out = "";
  let inClass = false;
  for (let k = 0; k < src.length; k++) {
    const ch = src[k]!;
    if (ch === "\\") {
      const next = src[k + 1]!;
      k++;
      if (inClass) throw new Error("pyRegex: escapes inside [...] are not supported");
      if (next === "b") out += out === "" || /[(|]$/.test(out) ? BOUND_START : BOUND_END;
      else if (next === "d") out += String.raw`\p{Nd}`;
      else if (next === "s") out += `[${WS}]`;
      else if (next === "w" || next === "B") throw new Error("pyRegex: \\w and \\B are not supported");
      else out += "\\" + next;
    } else if (inClass) {
      out += ch;
      if (ch === "]") inClass = false;
    } else if (ch === "[") {
      inClass = true;
      out += ch;
    } else if (ignoreCase && ch === "i") out += "[iıİ]";
    else out += ch;
  }
  return new RegExp(out, flags.includes("u") ? flags : flags + "u");
}

const NON_WS = new RegExp(`[^${WS}]+`, "gu");

/** Python `s.split()` (first `limit` words only, so a huge advert is not fully split). */
export function pyWords(s: string, limit = Infinity): string[] {
  const words: string[] = [];
  NON_WS.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (words.length < limit && (m = NON_WS.exec(s))) words.push(m[0]);
  return words;
}

const STRIP = new RegExp(`^[${WS}]+|[${WS}]+$`, "gu");
/** Python `s.strip()` */
export const pyStrip = (s: string): string => s.replace(STRIP, "");

/** Python `len(s)`: code points, not UTF-16 units. */
export const pyLen = (s: string): number => [...s].length;

/** Python `sorted(set_of_strings)`: by code point, not UTF-16 unit. */
export function pySortedUnique(items: Iterable<string>): string[] {
  return [...new Set(items)].sort((a, b) => {
    const x = Array.from(a);
    const y = Array.from(b);
    for (let k = 0; k < Math.min(x.length, y.length); k++) {
      const d = x[k]!.codePointAt(0)! - y[k]!.codePointAt(0)!;
      if (d) return d;
    }
    return x.length - y.length;
  });
}

/** Python `round(x, 2)`: exact on the stored value, ties to even (toFixed rounds ties up). */
export function pyRound2(x: number): number {
  const r = x * 8;
  if (Number.isInteger(r) && r % 2 !== 0) {
    const n = Math.floor(x * 100);
    return (n % 2 === 0 ? n : n + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/** Python `sum(floats)` (3.12 and later): compensated, so the last digits match. Plain `+` can differ. */
export function pySum(xs: Iterable<number>): number {
  let sum = 0;
  let c = 0;
  for (const x of xs) {
    const t = sum + x;
    c += Math.abs(sum) >= Math.abs(x) ? sum - t + x : x - t + sum;
    sum = t;
  }
  return c && Number.isFinite(c) ? sum + c : sum;
}
