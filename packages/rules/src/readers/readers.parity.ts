// Parity run for the readers: the TypeScript against the Python on every saved advert.
// Not part of `npm run check`. Run: PORTAL_PRIVATE_DATA="<private parity folder>" npx vitest run --config packages/rules/src/readers/vitest.parity.config.ts
// The adverts hold other sites' text: this file reads them, it never prints them.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "vitest";
import { checkSalary, doctorGradeWithoutTwoYears, noSponsorshipPhrase, permanentOrSpecifiedPurpose, readContract, readSalary, salaryStage, scamWording, sponsorshipAvailable } from "./index";

type Advert = { id?: string; title?: string | null; description?: string | null; employment_type?: string | null; salary_box?: string | null };
type Reference = Record<string, unknown> & { key: string; id: string; stages: Record<string, string> };

test("the TypeScript readers match the Python on every saved advert", () => {
  const dir = process.env.PORTAL_PRIVATE_DATA;
  if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set: point it at the private parity folder (it holds L1a/reference.json and the saved adverts)");
  const lane = join(dir, "L1a");
  const reference: Reference[] = JSON.parse(readFileSync(join(lane, "reference.json"), "utf8"));
  const adverts = new Map<string, Advert>();
  for (const f of readdirSync(lane).filter((n) => /^new-adverts-.*\.jsonl\.gz$/.test(n)).sort()) {
    gunzipSync(readFileSync(join(lane, f))).toString("utf8").split("\n").filter(Boolean).forEach((line, n) => adverts.set(`${f}:${n}`, JSON.parse(line)));
  }
  expect(reference.length).toBe(adverts.size);

  const differences: string[] = [];
  const compare = (ref: Reference, field: string, ts: unknown, py: unknown) => {
    if (ts !== py) differences.push(`${ref.id} ${ref.key} ${field}: ts=${JSON.stringify(ts)} py=${JSON.stringify(py)}`);
  };
  for (const ref of reference) {
    const j = adverts.get(ref.key)!;
    const title = j.title || "";
    const d = j.description || "";
    const contract = readContract(title, j.employment_type, d);
    const { low, high } = readSalary(d, j.salary_box ?? "");
    const check = checkSalary(low, high);
    compare(ref, "noSponsor", noSponsorshipPhrase(title, d), ref.noSponsor);
    compare(ref, "sponsorYes", sponsorshipAvailable(d), ref.sponsorYes);
    compare(ref, "scam", scamWording(d), ref.scam);
    compare(ref, "contract", contract.result, ref.contract);
    compare(ref, "contractWhy", contract.reason, ref.contractWhy);
    compare(ref, "doctorUnconfirmed", doctorGradeWithoutTwoYears(title, d), ref.doctorUnconfirmed);
    compare(ref, "permOrSp", permanentOrSpecifiedPurpose(d), ref.permOrSp);
    compare(ref, "low", low, ref.low);
    compare(ref, "high", high, ref.high);
    compare(ref, "check", check, ref.check);
    for (const big of [false, true]) for (const agency of [false, true]) compare(ref, `stage big=${big} agency=${agency}`, salaryStage(check, big, agency), ref.stages[`${Number(big)}${Number(agency)}`]);
  }
  console.log(`adverts compared: ${reference.length}, differences: ${differences.length}`);
  expect(differences).toEqual([]);
});
