// Parity run for the decision chain: the TypeScript `assess` against the Python's own `assess` (plus what classify.run sets on
// the way) on every saved advert. Reference made by step5/parity/L2/make_reference.py. Not part of `npm run check`.
// Reads private text on this machine only: it counts and compares, it never prints an advert.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { rulesMatcher } from "../../../matcher/src/rules";
import { BIG_COMPANY_LIST_150, cleanEmployerName, isBigCompany } from "../employers";
import { checkIrishEmployer, locationIsIrelandOnly, locationLooksIrish, postBasedElsewhere } from "../irish";
import { checkSalary, noSponsorshipPhrase, readContract, readSalary, salaryStage } from "../readers";
import { CHAIN_RULES_V1 } from "../snapshot";
import type { SalaryCheck, Stage } from "../types";
import { assess, bucketOf, monthsText, type AdvertInput } from "./assess";
import { CARE_CODES, HOSPITALITY_CODES } from "./sectors";

// #257: the sector the chain now gives where the Python said "other"; null for every other code, whose expectation is unchanged.
const newSector = (code: string | null) => (code && CARE_CODES.includes(code) ? "care" : code && HOSPITALITY_CODES.includes(code) ? "hospitality" : null);

type Saved = { id: string; source: string; board?: string; employer?: string | null; title?: string | null; location?: string | null; description?: string | null; url?: string; employment_type?: string | null; salary_box?: string | null };
type Ref = Record<string, unknown> & { id: string; stage: string; run_stage: string; bucket: string; known: boolean; public_tier: 0 | 1 | 2 };

const MIN = CHAIN_RULES_V1.minimums;
const passOr8 = (stage: string) => stage.startsWith("PASS") || stage.startsWith("8 ");
// The no-sponsorship wording added since the port: #156 (1), PR #25 and #159. The Python's own phrases never match this.
const NEW_REFUSAL = /be\s+(an?\s+)?(national|citizen)s?\s+of|to\s+work\s+in\s+(ireland|the\s+eu|the\s+eea)|right\s+to\s+work\s+in\s+ireland|work\s+authori[sz]ation/i;
// The short-contract wording added since the port: #156 (2) maternity cover, PR #25 placements, intern titles and "FTC".
const NEW_SHORT = /maternity|placement|year\s+students?|intern/i;

/**
 * The Python's answer with each deliberate rule change since the port applied, in chain order. Only adverts where a changed rule
 * gives a different answer from the Python's rule are touched, and only the fields that step and the steps after it set.
 * On 18 November 2026 this touches 78 adverts by #149 (77 by PR #18, 1 by PR #25's office list), 34 by new no-sponsorship wording
 * (27 #156, 7 PR #25 and #159), 5 by new short contracts, 10 by "/yr" pay, 112 by the big-company list and 53 Irish check reasons.
 */
function expected(ref: Ref, s: Saved): Ref {
  const e: Ref = { ...ref };
  const [title, desc, location, employer] = [s.title ?? "", s.description ?? "", s.location ?? "", s.employer ?? ""];
  // A new stop at stage 3 or 4: the rules after it never run, the Irish check is skipped. With no occupation code the sector is
  // "other", unless the employer is a pharma one (the Python's first sector test, which needs no code).
  const stop = (stage: Stage, reason: string | null) =>
    Object.assign(e, { stage, run_stage: stage, reason, soc: null, conf: null, contract: null, contract_why: null, salary_lo: null, salary_hi: null, salary: null, big: null, irish_verdict: null, irish_reason: null, sector: ref.sector === "pharma and science" ? ref.sector : "other" });
  // The stage the salary step now gives, put through the Irish check's override the way the Python did.
  const rerun = (run: Stage) => {
    if (ref.stage === ref.run_stage || (ref.stage.startsWith("3 unsure Irish employer") && !passOr8(run))) e.stage = run;
    e.run_stage = run;
  };

  if (!/^(0 |3 not in Ireland|4 )/.test(ref.run_stage) && locationLooksIrish(location)) {
    const phrase = noSponsorshipPhrase(title, desc);
    // NEW BEHAVIOUR (11 November 2026, #149): a job counts only when based in Ireland only.
    if (!locationIsIrelandOnly(location) || postBasedElsewhere(desc)) stop("3 not in Ireland", null);
    // NEW BEHAVIOUR (10 and 11 November 2026, #156, PR #25, #159): EU national wording and three right-to-work phrases are no sponsorship.
    else if (phrase !== null && NEW_REFUSAL.test(phrase)) stop("4 says no sponsorship", phrase);
  }
  if (e.contract === "ok") {
    const c = readContract(title, s.employment_type, desc, MIN.minContractMonths);
    // NEW BEHAVIOUR (10 and 11 November 2026, #156, PR #25): maternity cover, placements, intern titles and "FTC" are short.
    if (c.result === "short" && (NEW_SHORT.test(c.reason) || /\bftc\b/i.test(title + " " + desc))) {
      Object.assign(e, { contract: "short", contract_why: c.reason, salary_lo: null, salary_hi: null, salary: null, big: null });
      rerun(`7 contract under ${monthsText(MIN.minContractMonths)}`);
    }
  }
  if (e.salary !== null) {
    const pay = readSalary(desc, s.salary_box ?? "");
    // NEW BEHAVIOUR (10 November 2026, #156): pay written as "/yr", "/year" or "/annum" is read as yearly pay.
    if (e.salary_lo === null && pay.low !== null && /\/\s?(yr|year|annum|annual|pa)\b/i.test(s.salary_box + " " + desc)) {
      Object.assign(e, { salary_lo: pay.low, salary_hi: pay.high, salary: checkSalary(pay.low, pay.high, MIN.criticalSkills) });
    }
    // NEW BEHAVIOUR (11 November 2026, #150, #151): the big-company list.
    if (e.big === false && isBigCompany(employer, BIG_COMPANY_LIST_150)) e.big = true;
    if (e.salary !== ref.salary || e.big !== ref.big) rerun(salaryStage(e.salary as SalaryCheck, e.big === true, ref.agency === 1, MIN.criticalSkills));
  }
  // #150, #151: a listed employer is known, which the Irish check reads for a LinkedIn advert.
  if (e.irish_verdict !== null && !ref.known && s.source === "linkedin" && isBigCompany(employer, BIG_COMPANY_LIST_150)) {
    const irish = checkIrishEmployer({ employer, title, description: desc, location }, true);
    Object.assign(e, { known: true, irish_verdict: irish.verdict, irish_reason: irish.reason });
  }
  e.bucket = bucketOf(e.stage as Stage, ref.public_tier);
  e.reads_advert = !/^(0 |3 not|4 )/.test(e.stage) && e.bucket !== "no_salary" ? 1 : 0;
  return e;
}

test("the TypeScript chain matches the Python on every saved advert", async () => {
  const dir = process.env.PORTAL_PRIVATE_DATA;
  if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set: point it at the private parity folder (it holds L2/reference.json and the saved adverts)");
  const lane = join(dir, "L2");
  const reference: Ref[] = JSON.parse(readFileSync(join(lane, "reference.json"), "utf8"));
  const saved: Saved[] = [];
  for (const f of readdirSync(join(lane, "adverts")).filter((n) => /^new-adverts-.*\.jsonl\.gz$/.test(n)).sort()) {
    for (const line of gunzipSync(readFileSync(join(lane, "adverts", f))).toString("utf8").split("\n").filter(Boolean)) saved.push(JSON.parse(line));
  }
  expect(saved.length).toBe(reference.length);

  // The Python's own data, loaded the way run_day.py loads it.
  const dete = JSON.parse(readFileSync(join(lane, "dete-2026.json"), "utf8")) as [string, number][];
  const deteNames = new Set(dete.map(([name]) => cleanEmployerName(name)));
  const candidates = new Map<string, 1 | 2>(
    Object.entries(JSON.parse(readFileSync(join(lane, "public_employers_candidates.json"), "utf8")) as Record<string, { tier: 1 | 2 }>).map(([k, v]) => [k, v.tier]),
  );

  const differences: string[] = [];
  const tally = { tsBuckets: new Map<string, number>(), pyBuckets: new Map<string, number>(), tsStages: new Map<string, number>(), pyStages: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let matching = 0;
  for (const [i, s] of saved.entries()) {
    const py = reference[i]!;
    expect(s.id).toBe(py.id);
    const ref = expected(py, s);
    const advert: AdvertInput = { ...s, employmentType: s.employment_type, salaryBox: s.salary_box };
    const a = await assess(advert, { deteNames, publicPayCandidates: candidates, ...CHAIN_RULES_V1, matcher: rulesMatcher });
    const stageKey = (x: string) => x.split(":")[0]!;
    bump(tally.tsBuckets, a.bucket);
    bump(tally.pyBuckets, py.bucket);
    bump(tally.tsStages, stageKey(a.stage));
    bump(tally.pyStages, stageKey(py.stage));
    const pairs: [string, unknown, unknown][] = [
      ["stage", a.stage, ref.stage],
      ["bucket", a.bucket, ref.bucket],
      ["soc", a.occupationCode, ref.soc ?? null],
      ["conf", a.occupationConfidence, ref.conf ?? null],
      ["salary_lo", a.salaryLow, ref.salary_lo],
      ["salary_hi", a.salaryHigh, ref.salary_hi],
      ["agency", a.agency, ref.agency === 1],
      ["reads_advert", a.readsAdvert, ref.reads_advert === 1],
      // NEW BEHAVIOUR (#257, 18 November 2026): the Python has no care or hospitality sector; for those codes it said "other".
      ["sector", a.sector, ref.sector === "other" ? newSector(a.occupationCode) ?? ref.sector : ref.sector],
      ["reason", a.reason, ref.reason],
      ["sponsor_yes", a.sponsorYes, ref.sponsor_yes],
      // NEW BEHAVIOUR (10 November 2026): the scam rule drops warnings against scams, so it may clear a flag the Python set, never add one.
      ["scam_flag set where the Python set none", a.scamFlag && !ref.scam_flag, false],
      ["contract", a.contract, ref.contract],
      ["contract_why", a.contractReason, ref.contract_why],
      ["salary", a.salaryCheck, ref.salary],
      ["big", a.bigCompany, ref.big],
      ["irish_verdict", a.irishVerdict, ref.irish_verdict],
      ["irish_reason", a.irishReason, ref.irish_reason],
      ["public_tier", a.publicPayTier, ref.public_tier],
    ];
    const bad = pairs.filter(([, ts, py]) => ts !== py);
    if (a.stage === "0 advert too long (admin queue)") differences.push(`${ref.id} is over an input limit`);
    if (bad.length === 0) matching++;
    for (const [field, ts, py] of bad) differences.push(`${ref.id} ${field}: ts=${JSON.stringify(ts)} py=${JSON.stringify(py)}`);
  }
  const show = (m: Map<string, number>) => JSON.stringify(Object.fromEntries([...m].sort()));
  console.log(`L2 parity: ${saved.length} adverts, ${matching} match on every field, ${differences.length} differences`);
  console.log(`buckets ts ${show(tally.tsBuckets)}\nbuckets py ${show(tally.pyBuckets)}\nstages ts ${show(tally.tsStages)}\nstages py ${show(tally.pyStages)}`);
  expect(differences).toEqual([]);
});
