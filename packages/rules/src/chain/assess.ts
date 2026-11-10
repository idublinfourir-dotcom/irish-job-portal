// The decision chain: one advert in, one assessment out. Python: prototype/classify.py:194-231 (`run`) and
// prototype/step0/run_day.py:86-127 (`assess`), sector at run_day.py:56-76. The order the rules run in IS the behaviour.
import { isAgencyName, isBigCompany, cleanEmployerName, publicPayTier, type PublicPayCandidates } from "../employers";
import { checkIrishEmployer, locationLooksIrish } from "../irish";
import {
  checkSalary,
  doctorGradeWithoutTwoYears,
  noSponsorshipPhrase,
  permanentOrSpecifiedPurpose,
  readContract,
  readSalary,
  salaryStage,
  scamWording,
  sponsorshipAvailable,
} from "../readers";
import { cpHead, py } from "../readers/pyre";
import type { Assessment, Bucket, Sector, Stage } from "../types";

/** The shape of `RawAdvert` (packages/sources/src/types.ts) that the chain reads. Copied: this package does not depend on `@portal/sources`. */
export type AdvertInput = {
  id?: string;
  source: string;
  board?: string;
  employer?: string | null;
  title?: string | null;
  location?: string | null;
  description?: string | null;
  url?: string;
  employmentType?: string | null;
  salaryBox?: string | null;
};

/** The occupation matcher, same shape as `Matcher` in `@portal/matcher` (copied for the same reason). */
export type ChainMatcher = (
  title: string,
  description: string,
) => Promise<{ occupationCode: string; onCriticalSkillsList: "yes" | "no" | "unknown"; confidence: "none" | "low" | "medium" | "high" }>;

/** What the Python reads from globals (run_day.py:42-50). */
export type ChainData = {
  /** Cleaned DETE employer names (`cleanEmployerName` already applied), the keys of DETE_NORM (run_day.py:47-49). */
  deteNames: ReadonlySet<string>;
  /** The public pay-deal candidate names (public_employers_candidates.json), see `publicPayTier`. */
  publicPayCandidates: PublicPayCandidates;
  matcher: ChainMatcher;
};

// NEW BEHAVIOUR, not in the Python (10 November 2026). Adverts are untrusted text and three ported patterns slow down with
// the square of the input length (salary digits, name brackets, title rule 9). Over any limit the advert is not assessed.
// Counted in code points. Measured on the 1,310 saved adverts: longest title 142, employer 69, location 354, employment type 10,
// salary box 31, description 15,874.
export const INPUT_LIMITS = { title: 300, employer: 200, location: 500, employmentType: 100, salaryBox: 1000, description: 30000 } as const;

/** More than `max` code points? Cheap for huge strings: no copy, and the full count only when the length is in doubt. */
function overLimit(s: string | null | undefined, max: number): boolean {
  if (!s || s.length <= max) return false; // a code point is at least one UTF-16 unit, so this is never over
  if (s.length > 2 * max) return true; // a code point is at most two units, so this is always over
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n++;
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    if (n > max) return true;
  }
  return false;
}

// run_day.py:52, copied. Searched on the title.
const TEST_JOB = py(String.raw`do not apply|test req\b|test job|test posting`, "i");
// run_day.py:56. Searched on the employer.
const PHARMA = py(
  String.raw`pfizer|abbott|medtronic|thermo fisher|boston scientific|stryker|lilly|johnson and johnson|msd\b|novartis|sanofi|astrazeneca|amgen|regeneron|bristol|takeda|alkermes|icon\b`,
  "i",
);
// classify.py:101 (private inside the matcher, so one copy here; the parity run proves the sector is the same).
const IT_CONTEXT = py(
  String.raw`\b(software|cloud|aws|azure|gcp|saas|oracle|sap|salesforce|microsoft|dynamics|servicenow|workday|data platform|api|devops|agile|it systems?|erp|crm|python|java|sql)\b`,
  "i",
);
// run_day.py:58-64, in this order.
const SECTORS: readonly (readonly [Exclude<Sector, "other" | "pharma and science">, ReadonlySet<string>])[] = [
  ["health", new Set(["2211", "2212", "2213", "2214", "2217", "2218", "2219", "2221", "2222", "2223", "2229", "2231", "2232", "2442", "3213", "3218"])],
  ["IT", new Set(["1136", "2133", "2134", "2135", "2136", "2139", "2425"])],
  ["construction and engineering", new Set(["2121", "2122", "2123", "2124", "2126", "2127", "2129", "2431", "2432", "2433", "2434", "2435", "2436", "1122", "3122", "3531", "2463"])],
  ["finance", new Set(["2421", "2424", "2419"])],
];
const PHARMA_CODES = new Set(["2111", "2112", "2461", "2462"]);

/** run_day.py:67-76 `sector`. `code` is null when the occupation rule did not run (the Python reads `soc or ""`). */
function sectorOf(employer: string, title: string, description: string, code: string | null): Sector {
  if (PHARMA.test(employer)) return "pharma and science";
  const soc = code ?? "";
  for (const [sector, codes] of SECTORS) if (codes.has(soc)) return sector;
  if (PHARMA_CODES.has(soc)) return "pharma and science";
  if (soc === "212x/213x") return IT_CONTEXT.test(title + " " + cpHead(description, 2000)) ? "IT" : "construction and engineering";
  return "other";
}

/** run_day.py:107-123. D3: "8 range" is `stated_pay` although the stage is a drop. D4: the public tier changes only the bucket. */
function bucketOf(stage: Stage, tier: 0 | 1 | 2): Bucket {
  if (stage === "PASS (salary stated)") return "stated_pay";
  if (stage.startsWith("8 range")) return "stated_pay"; // #66: the top of the range clears the minimum
  if (stage.startsWith("8 ") && tier === 1) return "public_hse";
  if (stage.startsWith("8 ") && tier === 2) return "public_s38";
  if (stage === "PASS (big-company rule)") return "big_company";
  if (stage.startsWith("8 no salary")) return "no_salary";
  if (stage.includes("admin queue")) return "queue";
  return "rejected";
}

// An advert no rule ran on: every field empty, as the Python leaves a key out.
const blank = (): Assessment => ({
  stage: "0 advert too long (admin queue)",
  bucket: "queue",
  reason: null,
  agency: false,
  scamFlag: false,
  sponsorYes: false,
  occupationCode: null,
  occupationConfidence: null,
  contract: null,
  contractReason: null,
  salaryLow: null,
  salaryHigh: null,
  salaryCheck: null,
  bigCompany: null,
  irishVerdict: null,
  irishReason: null,
  publicPayTier: 0,
  sector: "other",
  readsAdvert: false,
});

/**
 * Run every rule on one advert, in the Python's order, and return the full assessment.
 * Async only because the matcher is (a later matcher may call an AI model).
 */
export async function assess(advert: AdvertInput, data: ChainData): Promise<Assessment> {
  const out = blank();
  if (
    overLimit(advert.title, INPUT_LIMITS.title) ||
    overLimit(advert.employer, INPUT_LIMITS.employer) ||
    overLimit(advert.location, INPUT_LIMITS.location) ||
    overLimit(advert.employmentType, INPUT_LIMITS.employmentType) ||
    overLimit(advert.salaryBox, INPUT_LIMITS.salaryBox) ||
    overLimit(advert.description, INPUT_LIMITS.description)
  ) {
    return out;
  }

  // run_day.py:88 empty fields made safe
  const employer = advert.employer || "";
  const title = advert.title || "";
  const location = advert.location || "";
  const description = advert.description || "";

  // classify.py:203-208 (run). The scam flag is computed and changes nothing (run_day.py:124-125 does not store it).
  out.agency = isAgencyName(employer);
  out.sponsorYes = sponsorshipAvailable(description);
  out.scamFlag = scamWording(description);
  let stage: Stage | null = null;

  // classify.py:209-210. D1: the location test runs before the "no sponsorship" test.
  if (!locationLooksIrish(location)) stage = "3 not in Ireland";
  else {
    const phrase = noSponsorshipPhrase(title, description);
    if (phrase !== null) {
      stage = "4 says no sponsorship";
      out.reason = phrase;
    }
  }

  // classify.py:211-216. The "not on the list" test comes before the "low confidence" test.
  if (!stage) {
    const m = await data.matcher(title, description);
    out.occupationCode = m.occupationCode;
    out.occupationConfidence = m.confidence;
    if (m.confidence === "none") stage = "5 occupation not recognised";
    else if (m.onCriticalSkillsList === "no") stage = "6 not on Critical Skills list";
    else if (m.confidence === "low") stage = "5 unsure occupation (admin queue)";
  }

  // classify.py:217-221
  if (!stage) {
    const c = readContract(title, advert.employmentType, description);
    out.contract = c.result;
    out.contractReason = c.reason;
    if (c.result === "short") stage = "7 contract under 2 years";
    else if (c.result === "unclear") stage = "7 contract unclear (admin queue)";
  }

  // classify.py:222-229
  if (!stage) {
    const { low, high } = readSalary(description, advert.salaryBox ?? "");
    out.salaryLow = low;
    out.salaryHigh = high;
    out.salaryCheck = checkSalary(low, high);
    out.bigCompany = isBigCompany(employer);
    stage = salaryStage(out.salaryCheck, out.bigCompany, out.agency);
  }

  // run_day.py:92. D2: every non-LinkedIn advert counts as known.
  const tier = publicPayTier(employer, data.publicPayCandidates);
  const known = advert.source !== "linkedin" || data.deteNames.has(cleanEmployerName(employer)) || isBigCompany(employer) || tier > 0;

  // run_day.py:93-99. The Irish check is skipped when the stage already starts with "3 " or "4 ".
  if (TEST_JOB.test(title)) stage = "0 test posting";
  else if (!stage.startsWith("3 ") && !stage.startsWith("4 ")) {
    const irish = checkIrishEmployer({ employer, title, description, location }, known);
    out.irishVerdict = irish.verdict;
    out.irishReason = irish.reason;
    if (irish.verdict === "not irish") stage = `3 not an Irish job: ${cpHead(irish.reason, 60)}`;
    // "unsure" queues only when the stage is a pass or starts with "8 "
    else if (irish.verdict === "unsure" && (stage.startsWith("PASS") || stage.startsWith("8 "))) stage = "3 unsure Irish employer (admin queue)";
  }

  // run_day.py:101-105, the two #95 rules, only on a pass or an "8 " stage
  if (stage.startsWith("PASS") || stage.startsWith("8 ")) {
    if (doctorGradeWithoutTwoYears(title, description)) stage = "7 doctor grade, contract unconfirmed (admin queue, #95)";
    else if (permanentOrSpecifiedPurpose(description)) stage = "7 permanent or specified purpose (admin queue, #95)";
  }

  out.stage = stage;
  out.publicPayTier = tier;
  out.bucket = bucketOf(stage, tier);
  // run_day.py:126. Quirk: "3 unsure Irish employer" does read the advert (it does not start with "3 not").
  out.readsAdvert = !/^(0 |3 not|4 )/.test(stage) && out.bucket !== "no_salary";
  out.sector = sectorOf(employer, title, description, out.occupationCode);
  return out;
}
