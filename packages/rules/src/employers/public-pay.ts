import { pyRegex, pyStrip } from "./py-text";

// R17 public pay-deal tier. Python: prototype/step0/run_day.py:45 (HSE pattern) and :79-83 (public_tier).
// NEW BEHAVIOUR (#299): the Python took any name with the word "hse", which also means health, safety and environment ("Acme HSE Contractors"). A tier 1 job now goes live
// with no pay check and no person, so the whole name must be one the HSE uses: its full name or "HSE", alone or with one of its regions or a county (and the few
// words its own names use). Any other word, or a letter that only looks right, is tier 0: no badge. The agency words (agency.ts) cannot be used here: "HSE Medical
// Manpower Donegal" is the HSE's own. A company that calls itself "HSE Dublin" would still pass, as one that calls itself a big company's name does (R14).
const SEP = "[ .,&()/-]";
const PLACE =
  "(dublin|midlands?|midwest|mid|north|south|east|west|carlow|cavan|clare|cork|donegal|galway|kerry|kildare|kilkenny|laois|leitrim|limerick|longford|louth|mayo|meath|monaghan|" +
  "offaly|roscommon|sligo|tipperary|waterford|westmeath|wexford|wicklow)";
const WORD = "(and|region|area|city|county|cho|recruitment|medical manpower|community healthcare|mental health services?)";
const HSE = pyRegex(`^(the )?(health service executive(${SEP}+hse)?|hse)((${SEP}+${WORD})*${SEP}+${PLACE}(${SEP}+(${WORD}|${PLACE}))*)?${SEP}*$`, "i");

/**
 * The public pay list (rules data, kind public_pay_employers): lower-case employer name to tier. The Section 38 names match exactly; the HSE entry
 * (HSE_ENTRY) is the HSE's on or off switch (#261) and matches by the name test above, not by exact name.
 */
export type PublicPayCandidates = ReadonlyMap<string, 1 | 2>;
/** The list entry that turns the HSE's tier 1 on (#261). Two staff turn it off by a version without it (the rules route, #229). */
export const HSE_ENTRY = "health service executive";

/** R17: 1 = the HSE's own name while HSE_ENTRY is on the list, 2 = listed candidate (exact lower-case name), else 0. */
export function publicPayTier(employer: string | null | undefined, candidates: PublicPayCandidates): 0 | 1 | 2 {
  const e = pyStrip(employer ?? "");
  if (candidates.has(HSE_ENTRY) && HSE.test(e)) return 1;
  return candidates.get(e.toLowerCase()) ?? 0;
}
