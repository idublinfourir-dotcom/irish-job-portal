// Parity run for the decision chain: the TypeScript `assess` against the Python's own `assess` (plus what classify.run sets on
// the way) on every saved advert. Reference made by step5/parity/L2/make_reference.py. Not part of `npm run check`.
// Reads private text on this machine only: it counts and compares, it never prints an advert.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { rulesMatcher } from "../../../matcher/src/rules";
import { cleanEmployerName } from "../employers";
import { assess, type AdvertInput } from "./assess";

type Saved = { id: string; source: string; board?: string; employer?: string | null; title?: string | null; location?: string | null; description?: string | null; url?: string; employment_type?: string | null; salary_box?: string | null };
type Ref = Record<string, unknown> & { id: string; stage: string; bucket: string };

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
    const ref = reference[i]!;
    expect(s.id).toBe(ref.id);
    const advert: AdvertInput = { ...s, employmentType: s.employment_type, salaryBox: s.salary_box };
    const a = await assess(advert, { deteNames, publicPayCandidates: candidates, matcher: rulesMatcher });
    const stageKey = (x: string) => x.split(":")[0]!;
    bump(tally.tsBuckets, a.bucket);
    bump(tally.pyBuckets, ref.bucket);
    bump(tally.tsStages, stageKey(a.stage));
    bump(tally.pyStages, stageKey(ref.stage));
    const pairs: [string, unknown, unknown][] = [
      ["stage", a.stage, ref.stage],
      ["bucket", a.bucket, ref.bucket],
      ["soc", a.occupationCode, ref.soc ?? null],
      ["conf", a.occupationConfidence, ref.conf ?? null],
      ["salary_lo", a.salaryLow, ref.salary_lo],
      ["salary_hi", a.salaryHigh, ref.salary_hi],
      ["agency", a.agency, ref.agency === 1],
      ["reads_advert", a.readsAdvert, ref.reads_advert === 1],
      ["sector", a.sector, ref.sector],
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
