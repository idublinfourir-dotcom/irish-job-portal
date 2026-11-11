// Wording tests on the advert text. Python: prototype/classify.py:15-22 (use at :206-210).
import { py } from "./pyre";

// R04 (#35). classify.py:15-20
const NO_SPONSOR = py(
  String.raw`(no|not|unable to|cannot|can't|can not|do not|don't|does not|will not|won't)\s+(\w+\s+){0,4}(offer|provide|support|consider|sponsor)\w*\s+(\w+\s+){0,3}(visa|sponsorship|work permit|employment permit)` +
    String.raw`|(visa|permit|immigration)\s+sponsorship\s+(is\s+)?(not|unavailable)` +
    String.raw`|without (the )?(need for |requiring )?(visa |employment |work )?(permit |sponsorship)` +
    String.raw`|must (already )?(have|hold|possess) (a |the |full |valid |current |unrestricted )*(right|permission|authori[sz]ation|eligibility|entitlement) to work` +
    String.raw`|(full|unrestricted|existing|current|valid) (right|permission|authori[sz]ation|entitlement) to work in (ireland|the eu|the eea)( is (required|essential|a must))?` +
    String.raw`|stamp 4|eu (citizen|passport|national)s? only|eu/eea (citizens?|nationals?) only` +
    // NEW BEHAVIOUR (10 November 2026): "requires you to be a national of an EU member state" cannot be met by a non-EEA applicant.
    // Found by the gate: two wrong passes. Not in the Python.
    String.raw`|(must|requir(?:e|es|ed)|need(?:s|ed)?)\s+(\w+\s+){0,3}be\s+(an?\s+)?(national|citizen)s?\s+of\s+(an?\s+|the\s+)?(eu|eea|european union)\b` +
    // NEW BEHAVIOUR (11 November 2026): three more ways an advert asks for the right to work before applying. Measured on the
    // 1,303 saved adverts with labels: "must be eligible / authorised to work in Ireland" 6 adverts, a requirements line that is only
    // "Right to work in Ireland" (and UK) 2, LinkedIn's form line "Work authorisation: Ireland (required)" 2. All 10 are labelled no.
    // The plain words "right to work in Ireland" are not a rule: they also come in "ability to obtain the right to work".
    String.raw`|must\s+be\s+(legally\s+|currently\s+|already\s+)?(eligible|entitled|authori[sz]ed|permitted)\s+to\s+work\s+in\s+(ireland|the\s+eu|the\s+eea)\b` +
    String.raw`|(?<![^\n])[ \t\u00a0•*-]{0,10}right\s+to\s+work\s+in\s+ireland(\s+and\s+(the\s+)?uk)?[ \t\u00a0]{0,10}\.?[ \t\u00a0]{0,10}(?![^\n])` +
    String.raw`|work\s+authori[sz]ation\s{0,3}:?\s{0,10}ireland\s{0,3}\(required\)`,
  "i",
);
// R05. classify.py:21
const SPONSOR_YES = py(
  String.raw`(visa|permit|immigration) sponsorship (is |will be )?(available|provided|offered|considered)|we (will|can|do) sponsor|sponsorship available|critical skills (employment )?permit`,
  "i",
);
// R06. classify.py:22: the Python's pattern as it is. "g" so every match in a description can be looked at.
const SCAM = py(
  String.raw`(pay|send|transfer)\s+(\w+\s+){0,3}(fee|deposit|processing charge)|registration fee|visa fee (is )?payable by (the )?candidate`,
  "gi",
);
// NEW BEHAVIOUR, not in the Python (10 November 2026). Measured on the 1,303 saved adverts: the pattern above matched 101, and
// every one was an employer's own warning against scams (100, in two wordings) or a benefit (1). So each match gets two tests:
// a warning: the same sentence says, before the match, "never", "against", "not ask / require / charge / need ...", "no" right
//   before it, or "no <somebody> will ask ...", and does not say "unless", "until" or "before" ("you will not be hired unless
//   you pay a fee" is a demand);
// a benefit: the fee is said to be paid, covered, reimbursed or refunded, and not by the candidate.
// A match that is neither is scam wording, wherever it stands: a warning early in the text does not excuse a demand later.
const WARNING = py(
  String.raw`\b(never|against)\b|(\bnot|n['’]t)\s+(\w+\s+){0,2}(ask|request|requir|charg|need|have)|\bno\s+(\w+\s+)?$|\b(no|nobody|none)\b.{0,120}(ask|request|requir|charg)`,
  "i",
);
const DEMAND = py(String.raw`\b(unless|until|before)\b`, "i");
const BENEFIT = py(
  String.raw`^s?\s+((are|is|will be)\s+)?(paid|covered|reimbursed|refunded)\b(?!\s+by\s+(the\s+)?(candidate|applicant|you)\b)`,
  "i",
);
const SENTENCE_BACK = 200; // how far back a sentence is read: the two real wordings need about 60 characters

/** R04: the first "no sponsorship" phrase in title + " " + description, or null. Python: `NO_SPONSOR.search(title + " " + d).group(0)` (classify.py:210). */
export function noSponsorshipPhrase(title: string, description: string): string | null {
  return NO_SPONSOR.exec(title + " " + description)?.[0] ?? null;
}

/** R05: the description says sponsorship is available. Python: `bool(SPONSOR_YES.search(d))` (classify.py:206). */
export function sponsorshipAvailable(description: string): boolean {
  return SPONSOR_YES.test(description);
}

/** The Python's own test, `bool(SCAM.search(d))` (classify.py:207), kept as it was so the parity run still proves the port. */
export function scamPatternPython(description: string): boolean {
  SCAM.lastIndex = 0;
  return SCAM.test(description);
}

/** R06: the description asks the candidate for money. The Python's pattern, minus warnings against scams and benefits (see above). */
export function scamWording(description: string): boolean {
  for (const m of description.matchAll(SCAM)) {
    const before = description.slice(Math.max(0, m.index - SENTENCE_BACK), m.index);
    const sentence = before.slice(Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1);
    const end = m.index + m[0].length;
    const warning = WARNING.test(sentence) && !DEMAND.test(sentence);
    if (!warning && !BENEFIT.test(description.slice(end, end + 60))) return true;
  }
  return false;
}
