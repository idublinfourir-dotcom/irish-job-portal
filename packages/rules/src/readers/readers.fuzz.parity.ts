// Fuzz half of the parity run: 60,000 made-up adverts (random mixes of money, wording, odd Unicode) answered by the Python.
// Not part of `npm run check`. Same command as readers.parity.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { MINIMUMS_V1 } from "../snapshot";
import { checkSalary, doctorGradeWithoutTwoYears, noSponsorshipPhrase, permanentOrSpecifiedPurpose, readContract, readSalary, scamPatternPython, sponsorshipAvailable } from "./index";
import { compareFrozen } from "./parity-causes";

type Case = { title: string; desc: string; box: string; etype: string | null; noSponsor: string | null; sponsorYes: boolean; scam: boolean; contract: string; contractWhy: string; doctorUnconfirmed: boolean; permOrSp: boolean; low: number | null; high: number | null; check: string };

test("the TypeScript readers match the Python on made-up adverts", () => {
  const dir = process.env.PORTAL_PRIVATE_DATA;
  if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set: point it at the private parity folder (it holds L1a/fuzz.json)");
  const cases: Case[] = JSON.parse(readFileSync(join(dir, "L1a", "fuzz.json"), "utf8"));
  const rows = cases.map((c, i) => {
    const contract = readContract(c.title, c.etype, c.desc, MINIMUMS_V1.minContractMonths);
    const { low, high } = readSalary(c.desc, c.box);
    const got = { noSponsor: noSponsorshipPhrase(c.title, c.desc), sponsorYes: sponsorshipAvailable(c.desc), scam: scamPatternPython(c.desc), contract: contract.result, contractWhy: contract.reason, doctorUnconfirmed: doctorGradeWithoutTwoYears(c.title, c.desc), permOrSp: permanentOrSpecifiedPurpose(c.desc), low, high, check: checkSalary(low, high, MINIMUMS_V1.criticalSkills) };
    return { key: String(i), title: c.title, desc: c.desc, box: c.box, pairs: Object.entries(got).map(([field, value]): [string, unknown, unknown] => [field, value, c[field as keyof Case]]) };
  });
  // The cases are a fixed file made with a fixed seed (make_fuzz.py), so deliberate changes are frozen per case index, as for the
  // saved adverts, in L1a/expected-changes-fuzz.json: see parity-causes.ts.
  const { differences, frozen } = compareFrozen(join(dir, "L1a", "expected-changes-fuzz.json"), rows);
  console.log(`cases compared: ${cases.length}, with frozen changes: ${frozen}, differences: ${differences.length}`);
  expect(differences.slice(0, 20)).toEqual([]);
});
