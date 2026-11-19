import { pyRegex, pyStrip } from "./py-text";

// R17 public pay-deal tier. Python: prototype/step0/run_day.py:45 (HSE pattern) and :79-83 (public_tier).
const HSE = pyRegex(String.raw`\bhse\b|health service executive`, "i");

/**
 * The public pay list (rules data, kind public_pay_employers): lower-case employer name to tier. The Section 38 names match exactly; the HSE entry
 * (HSE_ENTRY) is the HSE's on or off switch (#261) and matches by the name test above, not by exact name.
 */
export type PublicPayCandidates = ReadonlyMap<string, 1 | 2>;
/** The list entry that turns the HSE's tier 1 on (#261). Two staff turn it off by a version without it (the rules route, #229). */
export const HSE_ENTRY = "health service executive";

/** R17: 1 = HSE (name has "hse" or "health service executive") while HSE_ENTRY is on the list, 2 = listed candidate (exact lower-case name), else 0. */
export function publicPayTier(employer: string | null | undefined, candidates: PublicPayCandidates): 0 | 1 | 2 {
  const e = pyStrip(employer ?? "");
  if (HSE.test(e) && candidates.has(HSE_ENTRY)) return 1;
  return candidates.get(e.toLowerCase()) ?? 0;
}
