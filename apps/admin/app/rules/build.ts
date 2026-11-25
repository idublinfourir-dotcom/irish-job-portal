// What the rules forms send: each form's fields as the whole entry or version the route checks (docs/openapi/admin.yaml, POST /api/rules). The route checks every value again and says what
// is wrong; this only puts the fields in shape and catches an empty or non-numeric box early. Pure: the unit test passes FormData.
import type { BigName, Occupation, PayDealEntry, PayScale } from "@portal/db";
import { MIN_FIELD } from "./text";

export type Built<T> = { ok: true; value: T } | { ok: false; error: string };
const bad = (error: string): { ok: false; error: string } => ({ ok: false, error });
const s = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
const num = (f: FormData, k: string): number => (s(f, k) === "" ? Number.NaN : Number(s(f, k)));
const DAY = /^\d{4}-\d\d-\d\d$/;
/** A list of four-digit codes typed with commas, spaces or line breaks. */
export const parseCodes = (t: string): string[] => t.split(/[\s,;]+/).filter(Boolean);

export function minimumsData(f: FormData): Built<Record<string, unknown>> {
  const d: Record<string, unknown> = {};
  for (const k of ["criticalSkills", "graduate", "graduateMonths", "nonList", "minContractMonths", "standardWeekHours"]) {
    const v = num(f, k);
    if (!Number.isInteger(v)) return bad(`${MIN_FIELD[k]} must be a whole number.`);
    d[k] = v;
  }
  d.nonListRoute = f.get("nonListRoute") !== null;
  d.checkedOn = s(f, "checkedOn");
  if (!DAY.test(d.checkedOn as string)) return bad("Give the day the source was checked.");
  if (s(f, "general") === "") {
    if (s(f, "generalLower") !== "" || s(f, "generalLowerCodes") !== "" || s(f, "generalQuotaFullCodes") !== "") return bad("The General figures go together: fill in the General minimum too, or empty all four.");
  } else {
    const [g, l] = [num(f, "general"), num(f, "generalLower")];
    if (!Number.isInteger(g) || !Number.isInteger(l)) return bad("The General minimum and the lower rate must be whole numbers.");
    Object.assign(d, { general: g, generalLower: l, generalLowerCodes: parseCodes(s(f, "generalLowerCodes")), generalQuotaFullCodes: parseCodes(s(f, "generalQuotaFullCodes")) });
  }
  return { ok: true, value: d };
}

const PREFIX = { "critical-skills": "cs", ineligible: "in" } as const;
/** An entry of the Critical Skills or Ineligible list. A new one gets the id `cs-<code>` or `in-<code>` (a number after it when that id is taken); an edited one keeps its id. */
export function occupationEntry(f: FormData, list: "critical-skills" | "ineligible", existing: Occupation | null, taken: string[]): Built<Occupation> {
  const code = s(f, "code"), title = s(f, "title");
  if (!/^\d{4}$/.test(code)) return bad("The code is four digits.");
  if (title === "") return bad("Give the title.");
  let id = existing?.id ?? `${PREFIX[list]}-${code}`;
  for (let i = 2; existing === null && taken.includes(id); i++) id = `${PREFIX[list]}-${code}-${i}`;
  return { ok: true, value: { id, code, title, list } };
}

export function scaleEntry(f: FormData): Built<PayScale> {
  const [first, last, page] = [num(f, "firstEur"), num(f, "lastEur"), num(f, "sourcePage")];
  if (![first, last, page].every(Number.isInteger)) return bad("The first and last point and the page are whole numbers.");
  const note = s(f, "note");
  return { ok: true, value: { code: s(f, "code").toUpperCase(), title: s(f, "title"), firstEur: first, lastEur: last, sourceUrl: s(f, "sourceUrl"), sourcePage: page, ...(note === "" ? {} : { note }) } };
}

export function bigEntry(f: FormData): Built<BigName> {
  const name = s(f, "name").toLowerCase().replace(/\s+/g, " ");
  if (name === "") return bad("Give the name.");
  return { ok: true, value: { name, test: s(f, "test") as BigName["test"], link: s(f, "link") || null, readOn: s(f, "readOn") || null, reviewOn: s(f, "reviewOn") || null } };
}

/** One pay-deal entry from the form. `file` is the file just uploaded; without one the entry keeps the file it has. An entry stays as read where the form does not change it (day added, who added). */
export function payDealEntry(f: FormData, existing: PayDealEntry | null, file: { id: string; name: string } | null): Built<PayDealEntry> {
  const link = s(f, "link") || null, kept = file ?? existing?.evidence?.file ?? null;
  if (link === null && kept === null) return bad("Add a link, a file or both as evidence.");
  const note = s(f, "note");
  const e: PayDealEntry = {
    tier: existing?.tier ?? 2, bodyType: s(f, "bodyType") as PayDealEntry["bodyType"], evidence: { kind: s(f, "evidenceKind") as NonNullable<PayDealEntry["evidence"]>["kind"], link, file: kept },
    ...(note === "" ? {} : { note }), ...(existing?.addedOn ? { addedOn: existing.addedOn } : {}), ...(existing?.addedBy ? { addedBy: existing.addedBy } : {}), ...(f.get("on") === null ? { on: false as const } : {}),
  };
  return { ok: true, value: e };
}
/** The employer name as the list keys it: lower case, single spaces. */
export const employerKey = (t: string): string => t.trim().toLowerCase().replace(/\s+/g, " ");

export const withEntry = <T,>(list: readonly T[], at: number | null, e: T): T[] => (at === null ? [...list, e] : list.map((x, i) => (i === at ? e : x)));
export const without = <T,>(list: readonly T[], at: number): T[] => list.filter((_, i) => i !== at);
