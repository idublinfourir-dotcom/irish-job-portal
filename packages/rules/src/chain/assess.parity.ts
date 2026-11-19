// Parity run for the decision chain: the TypeScript `assess` against the Python's own `assess` (plus what classify.run sets on
// the way) on every saved advert. Reference made by step5/parity/L2/make_reference.py. Not part of `npm run check`.
// Reads private text on this machine only: it counts and compares, it never prints an advert.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { rulesMatcher } from "../../../matcher/src/rules";
import { cleanEmployerName, HSE_ENTRY } from "../employers";
import { CHAIN_RULES_V1 } from "../snapshot";
import { assess, type AdvertInput } from "./assess";

type Saved = { id: string; source: string; board?: string; employer?: string | null; title?: string | null; location?: string | null; description?: string | null; url?: string; employment_type?: string | null; salary_box?: string | null };
type Ref = Record<string, unknown> & { id: string; stage: string; run_stage: string; bucket: string; contract: string | null; salary_lo: number | null; big: boolean | null; sector: string };
type Changes = Record<string, { cause: string; fields: Record<string, unknown> }>;

/**
 * Where the chain now differs from the Python on purpose, frozen per advert in the private folder (L2/expected-changes.json: advert id,
 * cause, and the chain's value for each changed field; no advert text). The parity compares the chain with the Python reference with
 * these overrides only: any other difference fails, and so does an override the chain no longer gives. Every override names its
 * deliberate change; a difference no change below explains cannot be frozen. Regenerate on purpose only, after a deliberate rule
 * change: run with PARITY_WRITE_EXPECTED=1, then check the new overrides by hand.
 *
 * `causeOf` names the deliberate changes behind one advert's changed fields (the chain's values in `ts`), or null when none explains them.
 */
function causeOf(ts: Record<string, unknown>, py: Ref, source: string): string | null {
  const stopped = (stage: string) => ts.stage === stage && py.run_stage !== stage;
  const short = ts.contract === "short" && py.contract === "ok";
  const causes: [string, boolean][] = [
    // NEW BEHAVIOUR (11 November 2026, #149, PR #18; office lists PR #25): a job counts only when based in Ireland only.
    ["#149", stopped("3 not in Ireland")],
    // NEW BEHAVIOUR (10 November 2026, #156, PR #17): "must be a national of an EU member state" is no sponsorship.
    ["#156", stopped("4 says no sponsorship") && /national|citizen/i.test(ts.reason as string)],
    // NEW BEHAVIOUR (11 November 2026, PR #25 and #159, PR #26): three right-to-work phrases are no sponsorship.
    ["PR #25, #159", stopped("4 says no sponsorship") && /work/i.test(ts.reason as string)],
    // NEW BEHAVIOUR (10 November 2026, #156): maternity cover is a contract under two years.
    ["#156", short && /maternity/i.test(ts.contract_why as string)],
    // NEW BEHAVIOUR (11 November 2026, PR #25): FTC, student placements and intern titles are a contract under two years.
    ["PR #25", short && !/maternity/i.test(ts.contract_why as string)],
    // NEW BEHAVIOUR (10 November 2026, #156): pay written as "/yr" is read as yearly pay.
    ["#156", typeof ts.salary_lo === "number" && py.salary_lo === null],
    // NEW BEHAVIOUR (11 November 2026, #150, #151, PR #20): the big-company list; a listed employer is also known to the Irish check.
    ["#150, #151", ts.big === true && py.big === false],
    ["#150, #151", source === "linkedin" && ts.irish_reason === "employer known in Ireland"],
    // NEW BEHAVIOUR (18 November 2026, #257): the Python has no care or hospitality sector; for those codes it said "other".
    ["#257", py.sector === "other" && (ts.sector === "care" || ts.sector === "hospitality")],
  ];
  const named = [...new Set(causes.filter(([, hit]) => hit).map(([label]) => label))];
  return named.length > 0 ? named.join("; ") : null;
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
  // The Python's list has no HSE entry (its HSE test is always on); the HSE switch ON (#261) is the same thing.
  const candidates = new Map<string, 1 | 2>(
    Object.entries(JSON.parse(readFileSync(join(lane, "public_employers_candidates.json"), "utf8")) as Record<string, { tier: 1 | 2 }>).map(([k, v]) => [k, v.tier]),
  ).set(HSE_ENTRY, 1);

  const changesFile = join(lane, "expected-changes.json");
  const write = process.env.PARITY_WRITE_EXPECTED === "1";
  const changes: Changes = write ? {} : JSON.parse(readFileSync(changesFile, "utf8"));
  const unused = new Set(Object.keys(changes));
  const differences: string[] = [];
  const tally = { tsBuckets: new Map<string, number>(), pyBuckets: new Map<string, number>(), tsStages: new Map<string, number>(), pyStages: new Map<string, number>() };
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  let matching = 0;
  for (const [i, s] of saved.entries()) {
    const py = reference[i]!;
    expect(s.id).toBe(py.id);
    const advert: AdvertInput = { ...s, employmentType: s.employment_type, salaryBox: s.salary_box };
    const a = await assess(advert, { deteNames, publicPayCandidates: candidates, ...CHAIN_RULES_V1, matcher: rulesMatcher });
    const stageKey = (x: string) => x.split(":")[0]!;
    bump(tally.tsBuckets, a.bucket);
    bump(tally.pyBuckets, py.bucket);
    bump(tally.tsStages, stageKey(a.stage));
    bump(tally.pyStages, stageKey(py.stage));
    const pairs: [string, unknown, unknown][] = [
      ["stage", a.stage, py.stage],
      ["bucket", a.bucket, py.bucket],
      ["soc", a.occupationCode, py.soc ?? null],
      ["conf", a.occupationConfidence, py.conf ?? null],
      ["salary_lo", a.salaryLow, py.salary_lo],
      ["salary_hi", a.salaryHigh, py.salary_hi],
      ["agency", a.agency, py.agency === 1],
      ["reads_advert", a.readsAdvert, py.reads_advert === 1],
      ["sector", a.sector, py.sector],
      ["reason", a.reason, py.reason],
      ["sponsor_yes", a.sponsorYes, py.sponsor_yes],
      // NEW BEHAVIOUR (10 November 2026): the scam rule drops warnings against scams, so it may clear a flag the Python set, never add one.
      ["scam_flag set where the Python set none", a.scamFlag && !py.scam_flag, false],
      ["contract", a.contract, py.contract],
      ["contract_why", a.contractReason, py.contract_why],
      ["salary", a.salaryCheck, py.salary],
      ["big", a.bigCompany, py.big],
      ["irish_verdict", a.irishVerdict, py.irish_verdict],
      ["irish_reason", a.irishReason, py.irish_reason],
      ["public_tier", a.publicPayTier, py.public_tier],
    ];
    const changed = Object.fromEntries(pairs.filter(([, ts, py]) => ts !== py).map(([field, ts]) => [field, ts]));
    if (write && Object.keys(changed).length > 0) {
      const cause = causeOf(changed, py, s.source);
      if (cause) changes[py.id] = { cause, fields: changed };
    }
    const over = changes[py.id]?.fields ?? {};
    unused.delete(py.id);
    const bad = pairs.filter(([field, ts, pyv]) => (field in over ? ts !== over[field] || over[field] === pyv : ts !== pyv));
    for (const field of Object.keys(over)) if (!pairs.some(([f]) => f === field)) bad.push([field, "(no such field)", over[field]]);
    if (a.stage === "0 advert too long (admin queue)") differences.push(`${py.id} is over an input limit`);
    if (bad.length === 0) matching++;
    for (const [field, ts, pyv] of bad) differences.push(`${py.id} ${field}: ts=${JSON.stringify(ts)} expected=${JSON.stringify(field in over ? over[field] : pyv)}`);
  }
  for (const id of unused) differences.push(`${id} has frozen changes but is not a saved advert`);
  if (write) writeFileSync(changesFile, JSON.stringify(changes, null, 1) + "\n");
  const show = (m: Map<string, number>) => JSON.stringify(Object.fromEntries([...m].sort()));
  console.log(`L2 parity: ${saved.length} adverts, ${matching} match on every field, ${Object.keys(changes).length} with frozen changes, ${differences.length} differences`);
  console.log(`buckets ts ${show(tally.tsBuckets)}\nbuckets py ${show(tally.pyBuckets)}\nstages ts ${show(tally.tsStages)}\nstages py ${show(tally.pyStages)}`);
  expect(differences).toEqual([]);
});
