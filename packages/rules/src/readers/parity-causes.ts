// Shared by readers.parity.ts and readers.fuzz.parity.ts. Not part of `npm run check` (only the parity files import it).
// Reads private text on this machine only: it compares, it never prints an advert.
import { readFileSync, writeFileSync } from "node:fs";
import { readSalary, sponsorshipAvailable } from "./index";
import { py } from "./pyre";

/** One advert or made-up case: its text, and each compared field as [field, TypeScript value, Python value]. */
export type Row = { key: string; title: string; desc: string; box: string; pairs: [string, unknown, unknown][] };
type Changes = Record<string, { cause: string; fields: Record<string, unknown> }>;

// The evidence each deliberate change needs in the text. `py` so ignore-case works as in the readers (İ, ı, ſ).
const EU_NATIONAL = py(String.raw`\b(national|citizen)s?\s+of\b`, "i");
const RIGHT_TO_WORK_LINE = py(String.raw`right\s+to\s+work\s+in\s+ireland|work\s+authori[sz]ation`, "i");
const ELIGIBLE = py(String.raw`\b(eligible|entitled|authori[sz]ed|permitted)\s+to\s+work\b`, "i");
const SPONSOR_MAYBE = py(String.raw`sponsorship\s+(may|might|could|can)\s+be\s+(available|provided|offered|considered)`, "i");
const MATERNITY = py(String.raw`\bmaternity\b`, "i");
const PLACEMENT = py(String.raw`placement|\b(2nd|3rd|second|third|penultimate)[- ]year\s+students?\b`, "i");
const INTERN = py(String.raw`^intern(ship)?s?$`, "i");
const INTERN_TITLE = py(String.raw`\bintern(ship)?s?\b`, "i");
const MONTHS = py(String.raw`^\d+ months$`);
const FTC = py(String.raw`\b\d{1,2}[- ]?(month|mth)s?\b[^.\n]{0,40}\bftc|\bftc\b[^.\n]{0,30}\b\d{1,2}[- ]?(month|mth)s?\b`, "i");
const YEARLY = py(String.raw`(/\s?)(yr|year(ly)?|annum|annual(ly)?|pa)\b`, "gi");

/**
 * The deliberate change behind one changed field, named by its evidence in the text, or null when none explains it.
 * Every NEW BEHAVIOUR comment in contract.ts, wording.ts and salary.ts has one line here.
 */
export function causeOf(field: string, row: Row): string | null {
  const ts = (f: string) => row.pairs.find(([name]) => name === f)?.[1];
  const pyv = (f: string) => row.pairs.find(([name]) => name === f)?.[2];
  if (field === "noSponsor") {
    const phrase = ts("noSponsor");
    if (typeof phrase !== "string" || pyv("noSponsor") !== null) return null;
    const text = row.title + " " + row.desc;
    // 626dbd6 (10 November 2026, #156): "must be a national of an EU member state" is no sponsorship.
    if (EU_NATIONAL.test(phrase)) return "626dbd6 EU national wording";
    // a1c41a3 (11 November 2026, PR #25, #159): a "Right to work in Ireland" line, LinkedIn's "Work authorisation: Ireland (required)".
    if (RIGHT_TO_WORK_LINE.test(phrase)) return "a1c41a3 right-to-work line";
    // a1c41a3 and 7c32f89 (11 November 2026): "must be eligible to work in Ireland", only when the advert offers no sponsorship.
    if (ELIGIBLE.test(phrase) && !sponsorshipAvailable(text) && !SPONSOR_MAYBE.test(text)) return "a1c41a3, 7c32f89 eligible to work, no sponsorship offered";
    return null;
  }
  if (field === "contract" || field === "contractWhy") {
    const why = ts("contractWhy");
    if (ts("contract") !== "short" || typeof why !== "string") return null;
    // 626dbd6 (10 November 2026, #156): maternity cover is a contract under two years.
    if (MATERNITY.test(why)) return "626dbd6 maternity cover";
    // a1c41a3 (11 November 2026, PR #25): student placements, intern titles, "12 month FTC".
    if (PLACEMENT.test(why)) return "a1c41a3 student placement";
    if (INTERN.test(why) && INTERN_TITLE.test(row.title)) return "a1c41a3 intern title";
    if (MONTHS.test(why) && !MONTHS.test(String(pyv("contractWhy"))) && FTC.test(row.title + " " + row.desc)) return "a1c41a3 FTC";
    return null;
  }
  if (["low", "high", "check"].includes(field) || field.startsWith("stage")) {
    // 626dbd6 (10 November 2026, #156): pay written as "/yr" is yearly pay. Proof: with the yearly word blanked ("/yr" to "/xx",
    // which the Python skips as a revenue figure) the reader gives the Python's figures, so the yearly word is the only cause.
    const blank = (s: string) => s.replace(YEARLY, (_m, slash: string, word: string) => slash + "x".repeat(word.length));
    if (blank(row.desc) === row.desc && blank(row.box) === row.box) return null;
    const { low, high } = readSalary(blank(row.desc), blank(row.box));
    return low === pyv("low") && high === pyv("high") ? "626dbd6 pay written as /yr" : null;
  }
  return null;
}

/**
 * Compares every row with the Python, with the frozen changes in `file` (key, cause, the TypeScript value per changed field; no
 * text). Any other difference is returned, and so is a frozen change no row gives any more. A row is frozen only when `causeOf`
 * names a deliberate change for every one of its changed fields. Regenerate on purpose only, after a deliberate rule change:
 * PARITY_WRITE_EXPECTED=1, then check the new entries by hand.
 */
export function compareFrozen(file: string, rows: Row[]): { differences: string[]; frozen: number } {
  const write = process.env.PARITY_WRITE_EXPECTED === "1";
  const changes: Changes = write ? {} : JSON.parse(readFileSync(file, "utf8"));
  const unused = new Set(Object.keys(changes));
  const differences: string[] = [];
  for (const row of rows) {
    if (write) {
      const changed = row.pairs.filter(([, ts, pyv]) => ts !== pyv);
      const causes = changed.map(([field]) => causeOf(field, row));
      if (changed.length > 0 && causes.every(Boolean)) changes[row.key] = { cause: [...new Set(causes)].join("; "), fields: Object.fromEntries(changed.map(([f, ts]) => [f, ts])) };
    }
    const over = changes[row.key]?.fields ?? {};
    unused.delete(row.key);
    for (const [field, ts, pyv] of row.pairs) {
      const bad = field in over ? ts !== over[field] || over[field] === pyv : ts !== pyv;
      if (bad) differences.push(`${row.key} ${field}: ts=${JSON.stringify(ts)} expected=${JSON.stringify(field in over ? over[field] : pyv)}`);
    }
    for (const field of Object.keys(over)) if (!row.pairs.some(([f]) => f === field)) differences.push(`${row.key} ${field}: no such field`);
  }
  for (const key of unused) differences.push(`${key} has frozen changes but is not compared`);
  if (write) writeFileSync(file, JSON.stringify(changes, null, 1) + "\n");
  return { differences, frozen: Object.keys(changes).length };
}
