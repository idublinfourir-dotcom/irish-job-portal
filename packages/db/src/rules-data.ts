// The rules that decide badges, read from the database (#229): each kind is kept as whole versions in rules_version (migration 0021), and the
// version in force on a day is the confirmed one with the latest effective_from on or before it (the later id wins on the same date).
// No imports but types, so the daily run (rules-run-cli.ts) can load this file with plain node. The admin side is rules-admin.ts.
import type pg from "pg";

// The shared shape lives in packages/rules/src/snapshot.ts. A type-only import, erased when plain node runs the daily run (rules-run-cli.ts).
import type { Minimums, RulesSnapshot } from "@portal/rules";
export type { Minimums, RulesSnapshot };

export const RULES_KINDS = ["minimums", "critical_skills_list", "ineligible_list", "public_pay_employers", "big_company_names"] as const;
export type RulesKind = (typeof RULES_KINDS)[number];
export type Occupation = RulesSnapshot["occupationLists"][number];
/** One big-company name (#230): the test it passed, its link, the date read and the next review. The seed may leave the last three empty. */
export type BigName = { name: string; test: "brand" | "250_staff" | "dete_steady_sponsor"; link: string | null; readOn: string | null; reviewOn: string | null };
export type VersionData = Minimums | Occupation[] | Record<string, { tier: 1 | 2; note?: string }> | BigName[];

/** Data that does not fit its kind. The message names the kind and the first problem. */
export class BadRulesData extends Error {}

const MAX_ENTRIES = 2000;
const DATE = /^\d{4}-\d\d-\d\d$/;
export const validDate = (v: unknown): v is string =>
  typeof v === "string" && DATE.test(v) && !Number.isNaN(Date.parse(v)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
// Printable text: no control or format characters, not blank, not too long
const plain = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\p{Cc}\p{Cf}]/u.test(v);
// A cleaned employer name: lower-case letters and digits, single spaces (cleanEmployerName's output alphabet)
const CLEANED = /^[a-z0-9]+( [a-z0-9]+)*$/;
const TESTS: readonly string[] = ["brand", "250_staff", "dete_steady_sponsor"];
const keysAre = (o: object, need: string[], may: string[] = []) =>
  need.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => need.includes(k) || may.includes(k));
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

function fail(kind: string, why: string): never {
  throw new BadRulesData(`${kind}: ${why}`);
}

function list<T>(kind: string, v: unknown, one: (e: unknown, i: number) => T, key: (e: T) => string): T[] {
  if (!Array.isArray(v) || v.length === 0) fail(kind, "the list is empty or not a list");
  if (v.length > MAX_ENTRIES) fail(kind, "too many entries");
  const out = v.map(one), seen = new Set(out.map(key));
  if (seen.size !== out.length) fail(kind, "an entry appears twice");
  return out;
}

/** Checks one kind's data and returns it rebuilt from the checked fields only. Throws BadRulesData on anything else. */
export function cleanData(kind: RulesKind, v: unknown): VersionData {
  switch (kind) {
    case "minimums": {
      if (!isObject(v) || !keysAre(v, ["criticalSkills", "graduate", "graduateMonths", "nonList", "nonListRoute", "minContractMonths", "standardWeekHours", "checkedOn"]))
        fail(kind, "a minimum is missing or an unknown field is present");
      for (const k of ["criticalSkills", "graduate", "nonList"]) if (!int(v[k], 1, 1_000_000)) fail(kind, `${k} is not a positive whole euro amount`);
      for (const k of ["graduateMonths", "minContractMonths"]) if (!int(v[k], 1, 120)) fail(kind, `${k} is not a positive number of months`);
      if (!int(v.standardWeekHours, 1, 60)) fail(kind, "standardWeekHours is not 1 to 60");
      if (typeof v.nonListRoute !== "boolean") fail(kind, "nonListRoute is not true or false");
      if (!validDate(v.checkedOn)) fail(kind, "checkedOn is not a date");
      const m = v as Minimums;
      return { criticalSkills: m.criticalSkills, graduate: m.graduate, graduateMonths: m.graduateMonths, nonList: m.nonList, nonListRoute: m.nonListRoute,
        minContractMonths: m.minContractMonths, standardWeekHours: m.standardWeekHours, checkedOn: m.checkedOn };
    }
    case "critical_skills_list":
    case "ineligible_list": {
      const want = kind === "critical_skills_list" ? "critical-skills" : "ineligible";
      return list(kind, v, (e) => {
        if (!isObject(e) || !keysAre(e, ["id", "code", "title", "list"])) fail(kind, "an entry has missing or unknown fields");
        if (typeof e.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(e.id)) fail(kind, "an entry id is not valid");
        if (typeof e.code !== "string" || !/^\d{4}$/.test(e.code)) fail(kind, `${e.id}: the code is not four digits`);
        if (!plain(e.title, 2000)) fail(kind, `${e.id}: the title is empty, too long or has control characters`);
        if (e.list !== want) fail(kind, `${e.id}: the list is not ${want}`);
        return { id: e.id, code: e.code, title: e.title as string, list: want } as Occupation;
      }, (e) => e.id);
    }
    case "public_pay_employers": {
      if (!isObject(v) || Object.keys(v).length === 0) fail(kind, "the list is empty or not a list");
      if (Object.keys(v).length > MAX_ENTRIES) fail(kind, "too many entries");
      const out: Record<string, { tier: 1 | 2; note?: string }> = {};
      for (const [name, e] of Object.entries(v)) {
        if (!plain(name, 200) || name !== name.trim() || name !== name.toLowerCase()) fail(kind, "a name is not trimmed lower-case text");
        if (!isObject(e) || !keysAre(e, ["tier"], ["note"]) || (e.tier !== 1 && e.tier !== 2)) fail(kind, `${name}: needs tier 1 or 2 and at most a note`);
        if (e.note !== undefined && !plain(e.note, 500)) fail(kind, `${name}: the note is not plain text`);
        out[name] = e.note === undefined ? { tier: e.tier } : { tier: e.tier, note: e.note as string };
      }
      return out;
    }
    case "big_company_names":
      return list(kind, v, (e) => {
        if (!isObject(e) || !keysAre(e, ["name", "test", "link", "readOn", "reviewOn"])) fail(kind, "an entry has missing or unknown fields");
        if (typeof e.name !== "string" || e.name.length > 100 || !CLEANED.test(e.name)) fail(kind, "a name is not a cleaned name (lower-case letters, digits, single spaces)");
        if (typeof e.test !== "string" || !TESTS.includes(e.test)) fail(kind, `${e.name}: the test is not brand, 250_staff or dete_steady_sponsor`);
        if (e.link !== null && !(typeof e.link === "string" && e.link.length <= 500 && /^https:\/\/[^\s]+$/.test(e.link) && URL.canParse(e.link))) fail(kind, `${e.name}: the link is not an https address`);
        for (const k of ["readOn", "reviewOn"]) if (e[k] !== null && !validDate(e[k])) fail(kind, `${e.name}: ${k} is not a date`);
        return { name: e.name, test: e.test, link: e.link, readOn: e.readOn, reviewOn: e.reviewOn } as BigName;
      }, (e) => e.name);
  }
}

/** One kind's data as keyed entries, for the change shown to staff: the minimums by field, the lists by id or name. */
export function entriesOf(kind: RulesKind, data: VersionData): Map<string, unknown> {
  if (kind === "minimums" || kind === "public_pay_employers") return new Map(Object.entries(data));
  if (kind === "big_company_names") return new Map((data as BigName[]).map((e) => [e.name, e]));
  return new Map((data as Occupation[]).map((e) => [e.id, e]));
}

// The version in force for every kind on one day: one row per kind, newest effective_from on or before the day, later id first (rules_version_in_force_idx).
export const IN_FORCE =
  "select distinct on (kind) kind, data, id::text as id, effective_from::text as effective_from from rules_version where effective_from <= $1::date " +
  "order by kind, effective_from desc, id desc";

/**
 * The rules in force on `day` (YYYY-MM-DD). One query. Throws when a kind has no version, a list is empty or a minimum is missing or not positive,
 * so a run never goes on with half the rules.
 */
export async function loadRules(db: Pick<pg.ClientBase, "query">, day: string): Promise<RulesSnapshot> {
  if (!validDate(day)) throw new Error(`rules: "${day}" is not a date (YYYY-MM-DD)`);
  const rows = (await db.query<{ kind: RulesKind; data: unknown }>(IN_FORCE, [day])).rows;
  const by = new Map(rows.map((r) => [r.kind, r.data]));
  const get = <T extends VersionData>(kind: RulesKind): T => {
    if (!by.has(kind)) throw new Error(`rules: no ${kind} version is in force on ${day}`);
    try {
      return cleanData(kind, by.get(kind)) as T;
    } catch (e) {
      throw new Error(`rules: the ${kind} version in force on ${day} is not valid (${(e as Error).message})`);
    }
  };
  return {
    minimums: get<Minimums>("minimums"),
    occupationLists: [...get<Occupation[]>("critical_skills_list"), ...get<Occupation[]>("ineligible_list")],
    publicPayEmployers: get<Record<string, { tier: 1 | 2; note?: string }>>("public_pay_employers"),
    bigCompanyNames: get<BigName[]>("big_company_names").map((e) => e.name),
  };
}

// ponytail: one cache per process, keyed by the UTC day and kept 5 minutes, so a confirmed version reaches the apps within 5 minutes without a deploy.
const RULES_TTL_MS = 5 * 60_000;
let cached: { day: string; at: number; rules: Promise<RulesSnapshot> } | undefined;
/** The rules in force today (UTC) for the apps (#229): `loadRules`, read again on a new day or after 5 minutes. A failed read is not kept. */
export function getRules(db: Pick<pg.ClientBase, "query">, now: number = Date.now()): Promise<RulesSnapshot> {
  const day = new Date(now).toISOString().slice(0, 10);
  if (!cached || cached.day !== day || now - cached.at > RULES_TTL_MS) {
    const rules = loadRules(db, day);
    cached = { day, at: now, rules };
    rules.catch(() => { if (cached?.rules === rules) cached = undefined; });
  }
  return cached.rules;
}
