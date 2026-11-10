import { pyLen, pyRegex, pySortedUnique, pyWords } from "../employers/py-text";
import type { IrishVerdict } from "../types";

// R03. Python: prototype/irish_check.py (whole file). `employerKnown` is passed in (how it is computed is a later lane).

// irish_check.py:8. Place names that aggregators geocode wrongly.
const AMBIGUOUS_PLACES = pyRegex(String.raw`^\s*(hospital\s*,|remote\s*$|ireland\s*$)`, "i");

// irish_check.py:10-12
const STRONG_FOREIGN = pyRegex(
  String.raw`\bnhs\b|\bband [2-9]\b|\bnorthern ireland\b|\bbelfast\b|\bderry\b|\blondonderry\b` +
    String.raw`|\bco(unty|\.)? (antrim|armagh|down|fermanagh|tyrone)\b|\bespa[nñ]a\b|\bcatalunya\b`,
  "gi",
);
// irish_check.py:13
const WEAK_FOREIGN = pyRegex(
  String.raw`£\s?\d|\bgbp\b|\busd\b|\$\s?\d|\bscotland\b|\bengland\b|\bwales\b|\bunited kingdom\b|\bunited states\b|\bspain\b|\bgermany\b`,
  "gi",
);
// irish_check.py:14. Another of the four place lists: it adds fingal and dun laoghaire and has no irl or ireland (classify.py:12 differs).
const IRL_PLACE = pyRegex(
  String.raw`\b(dublin|cork|galway|limerick|shannon|waterford|kildare|meath|wicklow|westmeath|athlone|sligo|kinsale|leixlip|clonmel|letterkenny|donegal|drogheda|louth|dundalk|kilkenny|wexford|carlow|kerry|tralee|clare|ennis|naas|swords|tipperary|mayo|castlebar|roscommon|longford|cavan|monaghan|offaly|laois|leitrim|portlaoise|tullamore|mullingar|navan|bray|fingal|d[uú]n laoghaire)\b`,
  "i",
);
// irish_check.py:15. No ignore-case flag: capital letters only.
const EIRCODE = pyRegex(String.raw`\b[AC-FHKNPRTV-Y]\d{2}\s?[0-9AC-FHKNPRTV-Y]{4}\b`);
// irish_check.py:16-19. The lookbehind after \bireland\b only excludes the exact text "northern ireland" (one space).
const IRISH_TEXT = pyRegex(
  String.raw`\bireland\b(?<!northern ireland)|\bhse\b|\bco\. ?(dublin|cork|galway|limerick|kerry|clare|mayo|sligo|donegal|kildare|meath|wicklow|wexford|waterford|kilkenny|tipperary|louth|westmeath|offaly|laois|carlow|cavan|monaghan|longford|leitrim|roscommon)\b` +
    String.raw`|\bcounty (dublin|cork|galway|limerick|kerry|clare|mayo|sligo|donegal|kildare|meath|wicklow|wexford|waterford|kilkenny|tipperary|louth|westmeath|offaly|laois|carlow|cavan|monaghan|longford|leitrim|roscommon)\b` +
    String.raw`|\bnmbi\b|\bcoru\b|\bmedical council\b|\bstamp [14]\b|\bprsi\b|\bdublin \d{1,2}\b`,
  "i",
);
// irish_check.py:20
const ENGLISH = pyRegex(String.raw`\b(the|and|with|you|will|our|for|we|to|of)\b`, "gi");

// irish_check.py:27 (inline patterns)
const NORTHERN_LOCATION = pyRegex(String.raw`northern ireland|belfast|derry`, "i");
const IRELAND_WORD = pyRegex(String.raw`\bireland\b`, "i");
const REMOTE = pyRegex("remote", "i");

export type IrishCheckJob = { employer: string; title: string; description: string; location: string };
export type IrishCheckResult = { verdict: IrishVerdict; reason: string };

/**
 * R03: is this job with an employer in Ireland, by evidence? Python: irish_check.check (the Python returns the
 * reason as a one item list; here it is the one string).
 * `employerKnown`: the employer matched DETE, the brand table or CRO.
 */
export function checkIrishEmployer(job: IrishCheckJob, employerKnown: boolean): IrishCheckResult {
  const loc = job.location;
  const text = job.employer + " " + job.title + " " + job.description;
  if (NORTHERN_LOCATION.test(loc)) return { verdict: "not irish", reason: "location is in Northern Ireland (UK)" };
  const openingWords = pyWords(text, 300); // irish_check.py:29, " ".join(text.split()[:300]) then split again
  const opening = openingWords.join(" ");
  const words = Math.max(1, openingWords.length);
  const strong = pySortedUnique([...text.matchAll(STRONG_FOREIGN)].map((m) => m[0].toLowerCase()));
  if (words > 40 && openingWords.reduce((n, w) => n + pyLen(w), 0) / words < 2.5) {
    return { verdict: "unsure", reason: "advert text is garbled" };
  }
  if (words > 40 && [...opening.matchAll(ENGLISH)].length / words < 0.03) strong.push("advert not in English");
  const weak = pySortedUnique([...text.matchAll(WEAK_FOREIGN)].map((m) => m[0].toLowerCase()));
  const textIrish = EIRCODE.test(text) || IRISH_TEXT.test(text);
  const placeOk = IRL_PLACE.test(loc) && !AMBIGUOUS_PLACES.test(loc);
  if (strong.length > 0 && !textIrish) return { verdict: "not irish", reason: "strong foreign signs: " + strong.slice(0, 4).join(", ") };
  if (employerKnown && (placeOk || textIrish)) return { verdict: "irish", reason: "employer known in Ireland" };
  if (employerKnown && IRELAND_WORD.test(loc) && !REMOTE.test(loc) && !(strong.length > 0 || weak.length > 0)) {
    return { verdict: "irish", reason: "employer known in Ireland, location Ireland" };
  }
  if (placeOk && textIrish) return { verdict: "irish", reason: "Irish town and Irish details in the advert" };
  if (placeOk && weak.length === 0 && strong.length === 0) {
    return { verdict: "irish", reason: "Irish town, no foreign signs (employer still to match)" };
  }
  return {
    verdict: "unsure",
    reason: !placeOk ? "only a vague location" : "Irish town but foreign signs: " + [...strong, ...weak].slice(0, 4).join(", "),
  };
}
