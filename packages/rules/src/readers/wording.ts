// Wording tests on the advert text. Python: prototype/classify.py:15-22 (use at :206-210).
import { py } from "./pyre";

// R04 (#35). classify.py:15-20
const NO_SPONSOR = py(
  String.raw`(no|not|unable to|cannot|can't|can not|do not|don't|does not|will not|won't)\s+(\w+\s+){0,4}(offer|provide|support|consider|sponsor)\w*\s+(\w+\s+){0,3}(visa|sponsorship|work permit|employment permit)` +
    String.raw`|(visa|permit|immigration)\s+sponsorship\s+(is\s+)?(not|unavailable)` +
    String.raw`|without (the )?(need for |requiring )?(visa |employment |work )?(permit |sponsorship)` +
    String.raw`|must (already )?(have|hold|possess) (a |the |full |valid |current |unrestricted )*(right|permission|authori[sz]ation|eligibility|entitlement) to work` +
    String.raw`|(full|unrestricted|existing|current|valid) (right|permission|authori[sz]ation|entitlement) to work in (ireland|the eu|the eea)( is (required|essential|a must))?` +
    String.raw`|stamp 4|eu (citizen|passport|national)s? only|eu/eea (citizens?|nationals?) only`,
  "i",
);
// R05. classify.py:21
const SPONSOR_YES = py(
  String.raw`(visa|permit|immigration) sponsorship (is |will be )?(available|provided|offered|considered)|we (will|can|do) sponsor|sponsorship available|critical skills (employment )?permit`,
  "i",
);
// R06. classify.py:22
const SCAM = py(
  String.raw`(pay|send|transfer)\s+(\w+\s+){0,3}(fee|deposit|processing charge)|registration fee|visa fee (is )?payable by (the )?candidate`,
  "i",
);

/** R04: the first "no sponsorship" phrase in title + " " + description, or null. Python: `NO_SPONSOR.search(title + " " + d).group(0)` (classify.py:210). */
export function noSponsorshipPhrase(title: string, description: string): string | null {
  return NO_SPONSOR.exec(title + " " + description)?.[0] ?? null;
}

/** R05: the description says sponsorship is available. Python: `bool(SPONSOR_YES.search(d))` (classify.py:206). */
export function sponsorshipAvailable(description: string): boolean {
  return SPONSOR_YES.test(description);
}

/** R06: the description has scam wording. Python: `bool(SCAM.search(d))` (classify.py:207). */
export function scamWording(description: string): boolean {
  return SCAM.test(description);
}
