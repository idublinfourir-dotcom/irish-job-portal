// R09 contract length (#32). Python: prototype/classify.py:125-139 (use at :218-221).
import type { ContractResult } from "../types";
import { asciiDigits, cpHead, py } from "./pyre";

// classify.py:125-126. Groups 1 and 5 hold the number of months.
// NEW BEHAVIOUR (11 November 2026): "ftc" (fixed term contract) also counts, as in "Engineer (12 month FTC)". Found by the gate: two wrong passes.
const SHORT = py(
  String.raw`\b(\d{1,2})[- ]?(month|mth)s?\b[^.\n]{0,40}\b(contract|fixed|temporary|assignment|role|position|maternity|ftc)|` +
    String.raw`\b(contract|fixed[- ]term|temporary|assignment|ftc)\b[^.\n]{0,30}\b(\d{1,2})[- ]?(month|mth)s?\b`,
  "i",
);
// classify.py:127
const TEMP_WORDS = py(
  String.raw`\b(temporary|temp\b|maternity (leave )?cover|locum|seasonal|summer|internship|fixed[- ]term|specified purpose|relief)\b`,
  "i",
);
// classify.py:136
const TEMP_PHRASE = py(
  String.raw`\b(fixed[- ]term|temporary|maternity (leave )?cover|specified purpose|locum)\s+(contract|role|position|basis|post|vacancy)|this (is a |role is a |position is a )(temporary|fixed[- ]term|contract)`,
  "i",
);
// NEW BEHAVIOUR (10 November 2026), not in the Python. Maternity cover is temporary and under two years. The gate found a wrong pass
// whose text said "provides maternity cover for a ..." (the old patterns need "maternity cover contract" or the like).
const MATERNITY = py(String.raw`\bmaternity\s+(leave\s+)?cover\b|\bcover(ing)?\s+(for\s+)?(an?\s+|the\s+)?(\w+\s+){0,2}maternity\s+leave\b`, "i");

// NEW BEHAVIOUR (11 November 2026), not in the Python. Student placements and internships are short by nature. Found by the gate:
// two wrong passes whose text said "3rd Year Students with a dedicated Placement". Measured on the 1,303 saved adverts: these words
// hold only in those 2 adverts plus an intern advert, and all 3 are labelled no. The plain word "internship" is not a rule (46 adverts
// that talk of it are labelled yes), so an intern is only read in the title.
const PLACEMENT = py(String.raw`\bdedicated\s+placement\b|\b(2nd|3rd|second|third|penultimate)[- ]year\s+students?\b|\bstudent\s+placements?\b|\bplacement\s+students?\b`, "i");
const INTERN_TITLE = py(String.raw`\bintern(ship)?s?\b`, "i");

/** Python `contract(title, etype, desc)`: the result and the reason text. Only the first months figure is looked at. `minMonths` from the rules snapshot (#229). */
export function readContract(title: string, employmentType: string | null | undefined, description: string, minMonths: number): { result: ContractResult; reason: string } {
  const head = cpHead(description, 6000);
  const m = SHORT.exec(title + " " + head);
  if (m) {
    const n = Number(asciiDigits(m[1] ?? m[5]!));
    return { result: n < minMonths ? "short" : "ok", reason: `${n} months` };
  }
  const mat = MATERNITY.exec(title + " " + head);
  if (mat) return { result: "short", reason: mat[0] };
  const stu = PLACEMENT.exec(title + " " + head) ?? INTERN_TITLE.exec(title);
  if (stu) return { result: "short", reason: stu[0] };
  const et = (employmentType || "").toLowerCase();
  if (["temporary", "intern", "seasonal"].some((w) => et.includes(w))) return { result: "short", reason: employmentType! };
  if (et.includes("contract") || TEMP_WORDS.test(title)) return { result: "unclear", reason: employmentType || "title" };
  const p = TEMP_PHRASE.exec(head);
  if (p) return { result: "unclear", reason: p[0] };
  return { result: "ok", reason: "permanent or not stated" };
}
