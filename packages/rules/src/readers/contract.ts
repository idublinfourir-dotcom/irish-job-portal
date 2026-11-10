// R09 contract length (#32). Python: prototype/classify.py:125-139 (use at :218-221).
import type { ContractResult } from "../types";
import { asciiDigits, cpHead, py } from "./pyre";

// classify.py:125-126. Groups 1 and 5 hold the number of months.
const SHORT = py(
  String.raw`\b(\d{1,2})[- ]?(month|mth)s?\b[^.\n]{0,40}\b(contract|fixed|temporary|assignment|role|position|maternity)|` +
    String.raw`\b(contract|fixed[- ]term|temporary|assignment)\b[^.\n]{0,30}\b(\d{1,2})[- ]?(month|mth)s?\b`,
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

/** Python `contract(title, etype, desc)`: the result and the reason text. Only the first months figure is looked at. */
export function readContract(title: string, employmentType: string | null | undefined, description: string): { result: ContractResult; reason: string } {
  const head = cpHead(description, 6000);
  const m = SHORT.exec(title + " " + head);
  if (m) {
    const n = Number(asciiDigits(m[1] ?? m[5]!));
    return { result: n < 24 ? "short" : "ok", reason: `${n} months` };
  }
  const et = (employmentType || "").toLowerCase();
  if (["temporary", "intern", "seasonal"].some((w) => et.includes(w))) return { result: "short", reason: employmentType! };
  if (et.includes("contract") || TEMP_WORDS.test(title)) return { result: "unclear", reason: employmentType || "title" };
  const p = TEMP_PHRASE.exec(head);
  if (p) return { result: "unclear", reason: p[0] };
  return { result: "ok", reason: "permanent or not stated" };
}
