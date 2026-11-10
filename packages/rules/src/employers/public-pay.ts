import { pyRegex, pyStrip } from "./py-text";

// R17 public pay-deal tier. Python: prototype/step0/run_day.py:45 (HSE pattern) and :79-83 (public_tier).
const HSE = pyRegex(String.raw`\bhse\b|health service executive`, "i");

/**
 * The candidate list (Python: prototype/public_employers_candidates.json): lower-case employer name to tier.
 * The 7 names in the file are all marked unverified in the Python data.
 */
export type PublicPayCandidates = ReadonlyMap<string, 1 | 2>;

/** R17: 1 = HSE (name has "hse" or "health service executive"), 2 = listed candidate (exact lower-case name), else 0. */
export function publicPayTier(employer: string | null | undefined, candidates: PublicPayCandidates): 0 | 1 | 2 {
  const e = pyStrip(employer ?? "");
  if (HSE.test(e)) return 1;
  return candidates.get(e.toLowerCase()) ?? 0;
}
