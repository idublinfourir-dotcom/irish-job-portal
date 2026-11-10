// R12 salary reader (#66, #68) and R13 salary check (#66, #29). Python: prototype/classify.py:9, :142-177, use at :224-229.
import type { SalaryCheck, Stage } from "../types";
import { asciiDigits, cpHead, cpLength, cpTail, py, pyStrip } from "./pyre";

/** classify.py:9 `CS_MIN`. A parameter below, because it will come from rules data. */
export const DEFAULT_SALARY_MINIMUM = 40904;

// classify.py:142. The class in the first branch ends with U+202F (narrow no-break space), written by code point.
const NUM = String.raw`(\d{1,3}(?:[ ,. ]\d{3})+(?:[.,]\d{2})?|\d+(?:[.,]\d+)?\s?[kK]\b|\d{4,6}(?:[.,]\d{2})?)`;
// classify.py:143
const MONEY = py(String.raw`(?:€|eur\b|euro)\s?` + NUM + "|" + NUM + String.raw`\s?(?:€|eur\b|euro)`, "ig");
const MILLIONS = py(String.raw`^\s?(m|bn|million|billion)\b`); // classify.py:159
const SLASH_OR_POUND = py(String.raw`^\s?(/|£)`); // classify.py:159
// NEW BEHAVIOUR (10 November 2026), not in the Python. "€80,000.00/yr" is yearly pay, not a revenue figure. The gate found 4 qualifying
// adverts lost to the slash test. Hourly and daily forms are still told apart below. Read on the 25 characters in `after`.
const YEARLY = py(String.raw`^\s?/\s?(yr|year(ly)?|annum|annual(ly)?|pa)\b`);
const HOURLY = py(String.raw`per hour|p/h|/hr|an hour|hourly|ph\b`); // classify.py:163
const DAILY = py(String.raw`per day|daily rate|/day`); // classify.py:164
const NOT_PAY = py(String.raw`credit card|allowance|bonus|voucher|referral|relocation|budget|stipend|benefit`); // classify.py:165
const PAY_WORDS = py(String.raw`salary|pay range|base pay`); // classify.py:165
const THOUSANDS_AND_DECIMALS = py(String.raw`[ ,.]\d{3}[.,]\d{2}$`);
const THOUSANDS = py(String.raw`\d[ ,.]\d{3}$`);
const DECIMALS_AT_END = py(String.raw`[.,](\d{2})$`);

/** Python `to_num` (classify.py:144-152). Null when the text is not a number. */
function toNum(text: string): number | null {
  let s = pyStrip(text.replaceAll(" ", " ")); // classify.py:145
  const k = s.toLowerCase().endsWith("k");
  s = pyStrip(s.replace(/[kK]+$/, ""));
  if (THOUSANDS_AND_DECIMALS.test(s)) s = s.replace(DECIMALS_AT_END, "");
  s = THOUSANDS.test(s) ? s.replace(/[ ,.]/g, "") : s.replaceAll(",", ".");
  const v = Number(asciiDigits(s));
  if (Number.isNaN(v)) return null;
  return k ? v * 1000 : v;
}

/** R12. Python `salary(desc, box)`: the first amount and the largest amount within 80 characters after it, or nulls. */
export function readSalary(description: string, box = ""): { low: number | null; high: number | null } {
  const blob = box + "\n" + description;
  const found: [number, number][] = []; // [position in code points, amount]
  let lastIndex = 0;
  let position = 0;
  for (const m of blob.matchAll(MONEY)) {
    const start = m.index;
    const end = start + m[0].length;
    position += cpLength(blob.slice(lastIndex, start));
    lastIndex = start;
    const after = cpHead(blob.slice(end, end + 50), 25).toLowerCase();
    if (MILLIONS.test(after) || (SLASH_OR_POUND.test(cpHead(after, 3)) && !YEARLY.test(after))) continue; // revenue figures
    let v = toNum((m[1] ?? m[2])!);
    if (!v) continue;
    const around = (cpTail(blob.slice(Math.max(0, start - 240), start), 120) + m[0] + cpHead(blob.slice(end, end + 80), 40)).toLowerCase();
    if (HOURLY.test(around) && v < 200) v = v * 39 * 52;
    else if (DAILY.test(around)) continue;
    if (NOT_PAY.test(around) && !PAY_WORDS.test(around)) continue;
    if (v >= 15000 && v <= 400000) found.push([position, v]);
  }
  const first = found[0];
  if (!first) return { low: null, high: null };
  return { low: first[1], high: Math.max(...found.filter(([p]) => p - first[0] < 80).map(([, v]) => v)) };
}

/** R13. Python `salary_check(lo, hi)` (classify.py:173-177). */
export function checkSalary(low: number | null, high: number | null, minimum = DEFAULT_SALARY_MINIMUM): SalaryCheck {
  if (low === null) return "not stated";
  if (low >= minimum) return "pass";
  if (high && high >= minimum) return "range crosses";
  return "below";
}

export type SalaryStage = Extract<Stage, `8 ${string}` | `PASS ${string}`>;

/** R13 use. The stage the salary step gives (classify.py:225-229); `bigCompany` and `agency` are the plain flags the Python holds in `r["big"]` and `r["agency"]`. */
export function salaryStage(check: SalaryCheck, bigCompany: boolean, agency: boolean): SalaryStage {
  if (check === "below") return "8 salary below €40,904";
  if (check === "range crosses") return "8 range crosses €40,904 (no rule yet)";
  if (check === "not stated" && !(bigCompany && !agency)) return "8 no salary, not a big company";
  return check === "pass" ? "PASS (salary stated)" : "PASS (big-company rule)";
}
