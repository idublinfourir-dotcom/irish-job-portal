// R10 and R11 (#95). Python: prototype/step0/run_day.py:53-55, tests at :101-105.
// The Python only applies them when the stage starts "PASS" or "8 "; that gate belongs to the caller.
import { cpHead, py } from "./pyre";

// run_day.py:53
const DOCTOR_GRADE = py(String.raw`\b(registrar|senior house officer|sho|nchd|non[- ]consultant hospital doctor|fellow|fellowship|locum)\b`, "i");
// run_day.py:54
const TWO_YEARS = py(
  String.raw`\b([2-9]|two|three|four|five)[- ]years?\b[^.\n]{0,30}\b(contract|post|fixed|term)|\b(contract|post|fixed[- ]term)\b[^.\n]{0,30}\b([2-9]|two|three|four|five)[- ]years?\b`,
  "i",
);
// run_day.py:55
const PERM_OR_SP = py(
  String.raw`permanent\s*(/|or|and|&)\s*(specified purpose|temporary|fixed)|(specified purpose|temporary|fixed[- ]term)\s*(/|or|and|&)\s*permanent`,
  "i",
);

/** R10: a doctor grade in the title and no 2 years stated in the first 6,000 characters. Python: run_day.py:102. */
export function doctorGradeWithoutTwoYears(title: string, description: string): boolean {
  return DOCTOR_GRADE.test(title) && !TWO_YEARS.test(cpHead(description, 6000));
}

/** R11: "permanent / specified purpose" wording in the first 6,000 characters. Python: run_day.py:104. */
export function permanentOrSpecifiedPurpose(description: string): boolean {
  return PERM_OR_SP.test(cpHead(description, 6000));
}
