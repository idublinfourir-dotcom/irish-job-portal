// Parity run for the rules matcher: the TypeScript against the output of the real Python (classify.occupation)
// on the saved adverts and titles. The inputs are other sites' text and stay outside the repo, in
// $PORTAL_PRIVATE_DATA/L5/ (built by make_reference.py there). Nothing from them is printed: a difference
// is reported by position and advert id only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { occupation } from "./occupation";
import { pyRegex } from "./pyRegex";

const dir = process.env.PORTAL_PRIVATE_DATA;
const read = (name: string) => {
  if (!dir) throw new Error("PORTAL_PRIVATE_DATA is not set: point it at the step5/parity folder (the one that holds L5/)");
  return JSON.parse(readFileSync(join(dir, "L5", name), "utf8"));
};

type Ref = { code: string; cs: string; conf: string };
const differences = (inputs: { id?: string; title: string; description?: string }[], refs: Ref[]) => {
  const out: string[] = [];
  inputs.forEach((a, i) => {
    const got = occupation(a.title, a.description ?? "");
    const want = refs[i] as Ref;
    if (got.occupationCode !== want.code) out.push(`#${i} ${a.id ?? ""} code ts=${got.occupationCode} py=${want.code}`);
    if (got.onCriticalSkillsList !== want.cs) out.push(`#${i} ${a.id ?? ""} onList ts=${got.onCriticalSkillsList} py=${want.cs}`);
    if (got.confidence !== want.conf) out.push(`#${i} ${a.id ?? ""} confidence ts=${got.confidence} py=${want.conf}`);
  });
  return out;
};

describe("rules matcher parity with classify.py", () => {
  it("needs PORTAL_PRIVATE_DATA", () => {
    expect(dir, "set PORTAL_PRIVATE_DATA to the step5/parity folder").toBeTruthy();
  });

  it("matches the Python on every saved advert (title and description)", () => {
    const inputs = read("inputs-adverts.json");
    const diffs = differences(inputs, read("reference-adverts.json"));
    console.log(`adverts compared: ${inputs.length}, differences: ${diffs.length}`);
    expect(diffs).toEqual([]);
  });

  it("matches the Python on every saved title (empty description)", () => {
    const inputs = read("inputs-titles.json");
    const diffs = differences(inputs, read("reference-titles.json"));
    console.log(`titles compared: ${inputs.length}, differences: ${diffs.length}`);
    expect(diffs).toEqual([]);
  });

  it("matches the Python on 60,000 made-up titles and descriptions built from the rule words and odd characters", () => {
    const inputs = read("inputs-fuzz.json");
    const diffs = differences(inputs, read("reference-fuzz.json"));
    console.log(`fuzz compared: ${inputs.length}, differences: ${diffs.length}`);
    expect(diffs.slice(0, 20)).toEqual([]);
  });

  it("\\w, \\s and \\d match the code points Python's re matches (only code points Python's Unicode table has not assigned yet may differ)", () => {
    const py: Record<"w" | "s" | "d" | "unassigned", number[]> = read("charclasses.json");
    const unassigned = new Set(py.unassigned);
    for (const k of ["w", "s", "d"] as const) {
      const rx = pyRegex(`^\\${k}$`);
      const pySet = new Set(py[k]);
      const wrong: number[] = [];
      for (let c = 0; c < 0x110000; c++) {
        if (c >= 0xd800 && c < 0xe000) continue;
        const ours = rx.test(String.fromCodePoint(c));
        if (ours !== pySet.has(c) && !(ours && unassigned.has(c))) wrong.push(c);
      }
      expect(wrong, k).toEqual([]);
    }
  });
});
