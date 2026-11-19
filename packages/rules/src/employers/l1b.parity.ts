// Parity run for lane L1b: the TypeScript against the Python on every saved advert (reference made by
// step5/parity/L1b/ref.py). Reads private text on this machine only. Not part of `npm run check`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { checkIrishEmployer, locationLooksIrish } from "../irish";
import { BIG_COMPANY_NAMES_V1 } from "../snapshot";
import { BIG_COMPANY_BRANDS, BIG_COMPANY_LIST_150, buildNameMatcher, cleanEmployerName, isAgencyName, isBigCompany, nameTitlePlaceKey, publicPayTier, urlOrNameKey, HSE_ENTRY } from ".";

type Ref = {
  id: string;
  r02: boolean;
  r03_known: [string, string[]];
  r03_unknown: [string, string[]];
  name: string;
  brand: boolean;
  agency: boolean;
  tier: number;
  dup_url: string | string[];
  dup_name: string;
};
type Advert = { id: string; employer?: string | null; title?: string | null; location?: string | null; description?: string | null; url?: string | null };
type Suggest = Record<string, { name: string | null; score: number; kind: string }>;
type Changes = Record<string, { cause: string; fields: Record<string, unknown> }>;

/**
 * Where the TypeScript now differs from the Python on purpose, frozen per advert in the private folder (L1b/expected-changes.json for the saved
 * adverts, L1b/expected-changes-fuzz.json for the fuzz cases: id, cause, and the TypeScript's value for each changed field; no advert text), as
 * L2 does (chain/assess.parity.ts). Any other difference fails, and so does an override the TypeScript no longer gives. A difference no cause
 * below explains cannot be frozen. Regenerate on purpose only, after a deliberate rule change: PARITY_WRITE_EXPECTED=1, then check by hand.
 */
function causeOf(field: string, ts: unknown, py: unknown, employer: string): string | null {
  // NEW BEHAVIOUR (11 November 2026, #150, #151, commit 9bd3b88): the big-company list adds names the Python's 42 brands do not have.
  if (field === "brand" && ts === true && py === false && !isBigCompany(employer, BIG_COMPANY_BRANDS) && isBigCompany(employer, BIG_COMPANY_LIST_150)) return "#150, #151";
  return null;
}

const base = process.env.PORTAL_PRIVATE_DATA;
const need = (): string => {
  if (!base) throw new Error("PORTAL_PRIVATE_DATA is not set. Set it to the step5/parity folder (see vitest.parity.config.ts).");
  return join(base, "L1b");
};
const readJson = <T>(file: string): T => JSON.parse(readFileSync(join(need(), file), "utf8")) as T;

describe("L1b parity with the Python", () => {
  const compareAll = (adverts: Advert[], ref: Ref[], candidates: Map<string, 1 | 2>, changesName: string): string[] => {
    expect(adverts.length).toBe(ref.length);
    const changesFile = join(need(), changesName);
    const write = process.env.PARITY_WRITE_EXPECTED === "1";
    const changes: Changes = write ? {} : readJson<Changes>(changesName);
    const used = new Set<string>();
    const diffs: string[] = [];
    const cmp = (i: number, field: string, got: unknown, want: unknown) => {
      const id = ref[i]!.id;
      const same = (x: unknown) => JSON.stringify(got) === JSON.stringify(x);
      if (write && !same(want)) {
        const cause = causeOf(field, got, want, adverts[i]!.employer || "");
        if (cause) (changes[id] ??= { cause, fields: {} }).fields[field] = got;
      }
      const over = changes[id]?.fields ?? {};
      if (field in over) used.add(`${id}\t${field}`);
      const expected = field in over ? over[field] : want;
      if (!same(expected) || (field in over && same(want))) diffs.push(`advert #${i} (${id}) ${field}: ts=${JSON.stringify(got)} expected=${JSON.stringify(expected)} py=${JSON.stringify(want)}`);
    };
    adverts.forEach((a, i) => {
      const j = { employer: a.employer || "", title: a.title || "", location: a.location || "", description: a.description || "", url: a.url || "" };
      const r = ref[i]!;
      cmp(i, "id", a.id, r.id);
      cmp(i, "R02", locationLooksIrish(j.location), r.r02);
      const k = checkIrishEmployer(j, true);
      cmp(i, "R03 known", [k.verdict, [k.reason]], r.r03_known);
      const u = checkIrishEmployer(j, false);
      cmp(i, "R03 not known", [u.verdict, [u.reason]], r.r03_unknown);
      cmp(i, "clean name", cleanEmployerName(j.employer), r.name);
      cmp(i, "brand", isBigCompany(j.employer, BIG_COMPANY_NAMES_V1), r.brand);
      cmp(i, "agency", isAgencyName(j.employer), r.agency);
      cmp(i, "tier", publicPayTier(j.employer, candidates), r.tier);
      cmp(i, "duplicate key (url)", urlOrNameKey(j), typeof r.dup_url === "string" ? "u:" + r.dup_url : "t:" + JSON.stringify(r.dup_url));
      cmp(i, "duplicate key (name)", nameTitlePlaceKey(j.employer, j.title, j.location), r.dup_name);
    });
    for (const [id, c] of Object.entries(changes)) for (const f of Object.keys(c.fields)) if (!used.has(`${id}\t${f}`)) diffs.push(`${id} ${f} is frozen but was not compared`);
    if (write) writeFileSync(changesFile, JSON.stringify(changes, null, 1) + "\n");
    return diffs;
  };
  const publicCandidates = () =>
    new Map<string, 1 | 2>(Object.entries(readJson<Record<string, { tier: 1 | 2 }>>("public_employers_candidates.json")).map(([k, v]) => [k, v.tier])).set(HSE_ENTRY, 1); // the HSE switch ON (#261), as the Python

  it("matches the Python on every saved advert, field by field", () => {
    const dir = join(need(), "adverts");
    const adverts: Advert[] = readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl.gz"))
      .sort()
      .flatMap((f) => gunzipSync(readFileSync(join(dir, f))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Advert));
    const diffs = compareAll(adverts, readJson<Ref[]>("reference.json"), publicCandidates(), "expected-changes.json");
    console.log(`L1b parity: ${adverts.length} adverts, ${diffs.length} differences`);
    expect(diffs).toEqual([]);
  });

  it("matches the Python on random made-up inputs with odd Unicode (fuzz.json from fuzz_gen.py)", () => {
    const cases = readJson<(Advert & Ref)[]>("fuzz.json");
    const diffs = compareAll(cases, cases, publicCandidates(), "expected-changes-fuzz.json");
    console.log(`L1b fuzz: ${cases.length} cases, ${diffs.length} differences`);
    expect(diffs).toEqual([]);
  });

  const compareSuggestions = (prefix: string): { total: number; diffs: string[]; ties: number } => {
    const dete = readJson<[string, number][]>("dete-2026.json").map(([n]) => n);
    const seeds = [0, 1, 2, 3, 4].map((s) => readJson<Suggest>(`${prefix}-seed${s}.json`));
    const matcher = buildNameMatcher(dete);
    const diffs: string[] = [];
    let ties = 0;
    const employers = Object.keys(seeds[0]!);
    employers.forEach((employer, n) => {
      const want = seeds[0]![employer]!;
      const got = matcher.suggest(employer);
      const names = new Set(seeds.map((s) => s[employer]!.name));
      if (names.size > 1) ties++; // the Python itself changes answer with the hash seed
      const ok = got.kind === want.kind && got.score === want.score && names.has(got.name);
      if (!ok) diffs.push(`employer #${n}: ts=${JSON.stringify(got)} py=${JSON.stringify([...names])} ${want.kind} ${want.score}`);
    });
    return { total: employers.length, diffs, ties };
  };

  it("gives the same name suggestion as the Python for every distinct employer (R23)", () => {
    const { total, diffs, ties } = compareSuggestions("reference-suggest");
    console.log(`L1b parity R23: ${total} employers, ${diffs.length} differences, ${ties} ties the Python answers differently by hash seed`);
    expect(diffs).toEqual([]);
  });

  it("gives the same name suggestion as the Python for 1,500 made-up names (R23 fuzz)", () => {
    const { total, diffs, ties } = compareSuggestions("fuzz-suggest");
    console.log(`L1b fuzz R23: ${total} names, ${diffs.length} differences, ${ties} ties`);
    expect(diffs.slice(0, 20)).toEqual([]);
  });
});
