// Shared types for the job rules. Python: prototype/classify.py:194-231 (`run`) and prototype/step0/run_day.py:86-127 (`assess`).

// Every stage string, copied exactly from the Python. "3 not an Irish job: " + the reason cut to 60 chars (run_day.py:97).
export type Stage =
  | "0 test posting" // run_day.py:94
  // NEW, not in the Python (10 November 2026): an advert over an input length limit is refused before any rule runs, see chain/assess.ts.
  | "0 advert too long (admin queue)"
  | "3 not in Ireland" // classify.py:209
  | `3 not an Irish job: ${string}` // run_day.py:97
  | "3 unsure Irish employer (admin queue)" // run_day.py:99
  | "4 says no sponsorship" // classify.py:210
  | "5 occupation not recognised" // classify.py:214
  | "5 unsure occupation (admin queue)" // classify.py:216
  | "6 not on Critical Skills list" // classify.py:215
  | `7 contract under ${string}` // classify.py:220; the minimum in force (#229), "2 years" for 24 months
  | "7 contract unclear (admin queue)" // classify.py:221
  | "7 doctor grade, contract unconfirmed (admin queue, #95)" // run_day.py:102
  | "7 permanent or specified purpose (admin queue, #95)" // run_day.py:105
  | `8 salary below €${string}` // classify.py:226; the minimum in force (#229), "€40,904" in version 1
  | `8 range crosses €${string} (no rule yet)` // classify.py:227
  | "8 no salary, not a big company" // classify.py:228
  | "PASS (salary stated)" // classify.py:229
  | "PASS (big-company rule)"; // classify.py:229

// run_day.py:107-123
export type Bucket = "stated_pay" | "public_hse" | "public_s38" | "big_company" | "no_salary" | "queue" | "rejected";

// run_day.py:56-76 (SECTORS keys, "pharma and science", "other")
export type Sector = "health" | "IT" | "construction and engineering" | "finance" | "pharma and science" | "other";

export type SalaryCheck = "pass" | "range crosses" | "below" | "not stated"; // classify.py:173-177
export type ContractResult = "ok" | "short" | "unclear"; // classify.py:125-139
export type IrishVerdict = "irish" | "not irish" | "unsure"; // irish_check.py:23-49

// The full result of the rules for one advert. Fields the Python only sets when an earlier rule did not
// already stop the advert are null here (the Python leaves the key out).
export type Assessment = {
  /** `stage` */
  stage: Stage;
  /** `bucket` */
  bucket: Bucket;
  /** `why` (the matched "no sponsorship" phrase, classify.py:210), else null */
  reason: string | null;
  /** `agency` */
  agency: boolean;
  /** `scam_flag` (computed, not stored by run_day.py:124-125) */
  scamFlag: boolean;
  /** `sponsor_yes` */
  sponsorYes: boolean;
  /** `soc`: null when the occupation rule did not run (stage 3 or 4) */
  occupationCode: string | null;
  /** `conf`: null when the occupation rule did not run */
  occupationConfidence: "none" | "low" | "medium" | "high" | null;
  /** `contract`: null when the contract rule did not run */
  contract: ContractResult | null;
  /** `contract_why` */
  contractReason: string | null;
  /** `salary_lo` (a float in Python), null when none found or the salary rule did not run */
  salaryLow: number | null;
  /** `salary_hi` */
  salaryHigh: number | null;
  /** `salary`: null when the salary rule did not run */
  salaryCheck: SalaryCheck | null;
  /** `big` (classify.py:224): null when the salary rule did not run */
  bigCompany: boolean | null;
  /** `verdict` from irish_check.check (run_day.py:96): null when not run (stage 3 or 4 already, or a test posting) */
  irishVerdict: IrishVerdict | null;
  /** First item of the `why` list from irish_check.check (the Python returns a one item list) */
  irishReason: string | null;
  /** `public_tier(employer)`: 0 none, 1 HSE, 2 section 38 (run_day.py:79-83) */
  publicPayTier: 0 | 1 | 2;
  /** `sector` */
  sector: Sector;
  /** `reads_advert` (an int 0 or 1 in Python) */
  readsAdvert: boolean;
};
