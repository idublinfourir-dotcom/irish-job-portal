// The rules that decide badges, read from the database (#229): each kind is kept as whole versions in rules_version (migration 0021), and the
// version in force on a day is the confirmed one with the latest effective_from on or before it (the later id wins on the same date).
// No imports but types, so the daily run (rules-run-cli.ts) can load this file with plain node. The admin side is rules-admin.ts.
import type pg from "pg";

// The shared shape lives in packages/rules/src/snapshot.ts. A type-only import, erased when plain node runs the daily run (rules-run-cli.ts).
import type { Minimums, PayScale, RulesSnapshot } from "@portal/rules";
export type { Minimums, PayScale, RulesSnapshot };

export const RULES_KINDS = ["minimums", "critical_skills_list", "ineligible_list", "public_pay_employers", "big_company_names", "pay_scales"] as const;
export type RulesKind = (typeof RULES_KINDS)[number];
export type Occupation = RulesSnapshot["occupationLists"][number];
/** One big-company name (#230): the test it passed, its link, the date read and the next review. The seed may leave the last three empty. */
export type BigName = { name: string; test: "brand" | "250_staff" | "dete_steady_sponsor"; link: string | null; readOn: string | null; reviewOn: string | null };
/** B66: one public pay-deal employer. `on` is kept only as false (an entry that is off stays on the list and never counts); `addedOn` and `addedBy` are set by the server. */
export const BODY_TYPES = ["public_body", "section_38", "section_39"] as const;
export const EVIDENCE_KINDS = ["service_arrangement", "published_pay_policy", "dete_rule_text", "other"] as const;
export type PayDealEvidence = { kind: (typeof EVIDENCE_KINDS)[number]; link: string | null; file: { id: string; name: string } | null };
export type PayDealEntry = { tier: 1 | 2; note?: string; bodyType?: (typeof BODY_TYPES)[number]; evidence?: PayDealEvidence; addedOn?: string; addedBy?: string; on?: false };
export type PayDealList = Record<string, PayDealEntry>;
export type VersionData = Minimums | Occupation[] | PayDealList | BigName[] | PayScale[];
/** An uploaded evidence file's id, `<uuid>.<ext>`: its storage key is `rules/<id>`, so an id can never name another file in the store. */
export const EVIDENCE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|jpg|png)$/;

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
const GENERAL = ["general", "generalLower", "generalLowerCodes", "generalQuotaFullCodes"];
const codes = (v: unknown) => Array.isArray(v) && v.length <= 200 && v.every((c) => typeof c === "string" && /^\d{4}$/.test(c)) && new Set(v).size === v.length;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const int = (v: unknown, lo: number, hi: number) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const https = (v: unknown) => typeof v === "string" && v.length <= 500 && /^https:\/\/[^\s]+$/.test(v) && URL.canParse(v);

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

function evidence(kind: string, name: string, v: unknown): PayDealEvidence {
  if (!isObject(v) || !keysAre(v, ["kind", "link", "file"])) fail(kind, `${name}: the evidence needs kind, link and file only`);
  if (!(EVIDENCE_KINDS as readonly unknown[]).includes(v.kind)) fail(kind, `${name}: the evidence kind is not known`);
  if (v.link !== null && !https(v.link)) fail(kind, `${name}: the evidence link is not an https address`);
  const f = v.file;
  if (f !== null && (!isObject(f) || !keysAre(f, ["id", "name"]) || typeof f.id !== "string" || !EVIDENCE_FILE.test(f.id) || !plain(f.name, 200))) fail(kind, `${name}: the evidence file is not an uploaded file`);
  if (v.link === null && f === null) fail(kind, `${name}: the evidence needs a link or a file`);
  return { kind: v.kind as PayDealEvidence["kind"], link: v.link as string | null, file: f === null ? null : { id: (f as { id: string }).id, name: (f as { name: string }).name } };
}

/** Checks one kind's data and returns it rebuilt from the checked fields only. Throws BadRulesData on anything else. */
export function cleanData(kind: RulesKind, v: unknown): VersionData {
  switch (kind) {
    case "minimums": {
      if (!isObject(v) || !keysAre(v, ["criticalSkills", "graduate", "graduateMonths", "nonList", "nonListRoute", "minContractMonths", "standardWeekHours", "checkedOn"], GENERAL))
        fail(kind, "a minimum is missing or an unknown field is present");
      for (const k of ["criticalSkills", "graduate", "nonList"]) if (!int(v[k], 1, 1_000_000)) fail(kind, `${k} is not a positive whole euro amount`);
      for (const k of ["graduateMonths", "minContractMonths"]) if (!int(v[k], 1, 120)) fail(kind, `${k} is not a positive number of months`);
      if (!int(v.standardWeekHours, 1, 60)) fail(kind, "standardWeekHours is not 1 to 60");
      if (typeof v.nonListRoute !== "boolean") fail(kind, "nonListRoute is not true or false");
      if (!validDate(v.checkedOn)) fail(kind, "checkedOn is not a date");
      const has = GENERAL.filter((k) => Object.hasOwn(v, k)).length;
      if (has !== 0 && has !== GENERAL.length) fail(kind, "the four General permit fields are all present or all absent");
      if (has) {
        for (const k of ["general", "generalLower"]) if (!int(v[k], 1, 1_000_000)) fail(kind, `${k} is not a positive whole euro amount`);
        for (const k of ["generalLowerCodes", "generalQuotaFullCodes"]) if (!codes(v[k])) fail(kind, `${k} is not a list of four-digit codes`);
      }
      const m = v as Minimums;
      return { criticalSkills: m.criticalSkills, graduate: m.graduate, graduateMonths: m.graduateMonths, nonList: m.nonList, nonListRoute: m.nonListRoute,
        minContractMonths: m.minContractMonths, standardWeekHours: m.standardWeekHours, checkedOn: m.checkedOn,
        ...(has ? { general: m.general, generalLower: m.generalLower, generalLowerCodes: [...m.generalLowerCodes!], generalQuotaFullCodes: [...m.generalQuotaFullCodes!] } : {}) };
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
      const out: PayDealList = {};
      for (const [name, e] of Object.entries(v)) {
        if (!plain(name, 200) || name !== name.trim() || name !== name.toLowerCase()) fail(kind, "a name is not trimmed lower-case text");
        if (!isObject(e) || !keysAre(e, ["tier"], ["note", "bodyType", "evidence", "addedOn", "addedBy", "on"]) || (e.tier !== 1 && e.tier !== 2)) fail(kind, `${name}: needs tier 1 or 2 and known fields only`);
        if (e.note !== undefined && !plain(e.note, 500)) fail(kind, `${name}: the note is not plain text`);
        if (e.bodyType !== undefined && !(BODY_TYPES as readonly unknown[]).includes(e.bodyType)) fail(kind, `${name}: the body type is not public_body, section_38 or section_39`);
        if (e.addedOn !== undefined && !validDate(e.addedOn)) fail(kind, `${name}: addedOn is not a date`);
        if (e.addedBy !== undefined && (typeof e.addedBy !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(e.addedBy))) fail(kind, `${name}: addedBy is not a staff id`);
        if (e.on !== undefined && typeof e.on !== "boolean") fail(kind, `${name}: on is not true or false`);
        out[name] = {
          tier: e.tier, ...(e.note === undefined ? {} : { note: e.note as string }), ...(e.bodyType === undefined ? {} : { bodyType: e.bodyType as PayDealEntry["bodyType"] }),
          ...(e.evidence === undefined ? {} : { evidence: evidence(kind, name, e.evidence) }), ...(e.addedOn === undefined ? {} : { addedOn: e.addedOn }),
          ...(e.addedBy === undefined ? {} : { addedBy: e.addedBy as string }), ...(e.on === false ? { on: false as const } : {}),
        };
      }
      // an empty list would stop the fetch (checkSnapshot), as a list with no entry does
      if (!Object.values(out).some((e) => e.on !== false)) fail(kind, "every entry is off");
      return out;
    }
    case "big_company_names":
      return list(kind, v, (e) => {
        if (!isObject(e) || !keysAre(e, ["name", "test", "link", "readOn", "reviewOn"])) fail(kind, "an entry has missing or unknown fields");
        if (typeof e.name !== "string" || e.name.length > 100 || !CLEANED.test(e.name)) fail(kind, "a name is not a cleaned name (lower-case letters, digits, single spaces)");
        if (typeof e.test !== "string" || !TESTS.includes(e.test)) fail(kind, `${e.name}: the test is not brand, 250_staff or dete_steady_sponsor`);
        if (e.link !== null && !https(e.link)) fail(kind, `${e.name}: the link is not an https address`);
        for (const k of ["readOn", "reviewOn"]) if (e[k] !== null && !validDate(e[k])) fail(kind, `${e.name}: ${k} is not a date`);
        return { name: e.name, test: e.test, link: e.link, readOn: e.readOn, reviewOn: e.reviewOn } as BigName;
      }, (e) => e.name);
    case "pay_scales":
      return list(kind, v, (e) => {
        if (!isObject(e) || !keysAre(e, ["code", "title", "firstEur", "lastEur", "sourceUrl", "sourcePage"], ["note"])) fail(kind, "an entry has missing or unknown fields");
        if (typeof e.code !== "string" || !/^[A-Z0-9]{1,12}$/.test(e.code)) fail(kind, "a grade code is not 1 to 12 capital letters or digits");
        if (!plain(e.title, 200)) fail(kind, `${e.code}: the title is empty, too long or has control characters`);
        if (!int(e.firstEur, 1, 1_000_000) || !int(e.lastEur, e.firstEur as number, 1_000_000)) fail(kind, `${e.code}: the scale is not whole euro amounts from first to last`);
        if (!https(e.sourceUrl)) fail(kind, `${e.code}: the source is not an https address`);
        if (!int(e.sourcePage, 1, 10_000)) fail(kind, `${e.code}: the source page is not a page number`);
        if (e.note !== undefined && !plain(e.note, 500)) fail(kind, `${e.code}: the note is not plain text`);
        const out: PayScale = { code: e.code, title: e.title as string, firstEur: e.firstEur as number, lastEur: e.lastEur as number, sourceUrl: e.sourceUrl as string, sourcePage: e.sourcePage as number };
        return e.note === undefined ? out : { ...out, note: e.note as string };
      }, (e) => e.code);
  }
}

/** One kind's data as keyed entries, for the change shown to staff: the minimums by field, the lists by id or name. */
export function entriesOf(kind: RulesKind, data: VersionData): Map<string, unknown> {
  if (kind === "minimums" || kind === "public_pay_employers") return new Map(Object.entries(data));
  if (kind === "big_company_names") return new Map((data as BigName[]).map((e) => [e.name, e]));
  if (kind === "pay_scales") return new Map((data as PayScale[]).map((e) => [e.code, e]));
  return new Map((data as Occupation[]).map((e) => [e.id, e]));
}

// The version in force for every kind on one day: one row per kind, newest effective_from on or before the day, later id first (rules_version_in_force_idx).
export const IN_FORCE =
  "select distinct on (kind) kind, data, id::text as id, effective_from::text as effective_from from rules_version where effective_from <= $1::date " +
  "order by kind, effective_from desc, id desc";

const PAY_DEALS = "select data from rules_version where kind = 'public_pay_employers' and effective_from <= $1::date order by effective_from desc, id desc limit 1";

/**
 * The rules in force on `day` (YYYY-MM-DD). One query. Throws when a kind has no version, a list is empty or a minimum is missing or not positive,
 * so a run never goes on with half the rules. The pay scales (#269) are the one kind that may have no version yet: then `payScales` is left out.
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
    // B66: an entry that is off is not in the snapshot at all, so no badge, posting check or fetch that reads the rules can count it; the shape is unchanged
    publicPayEmployers: payDealsOn(get<PayDealList>("public_pay_employers")),
    bigCompanyNames: get<BigName[]>("big_company_names").map((e) => e.name),
    ...(by.has("pay_scales") ? { payScales: get<PayScale[]>("pay_scales") } : {}),
  };
}

const payDealsOn = (list: PayDealList): RulesSnapshot["publicPayEmployers"] => Object.fromEntries(Object.entries(list).filter(([, e]) => e.on !== false)
  .map(([name, e]) => [name, e.note === undefined ? { tier: e.tier } : { tier: e.tier, note: e.note }]));

/** The pay-deal employers that are on now, never the cached copy: the company page's label, so an entry switched off loses it at once (B66). One small row. */
export async function freshPayDeals(db: Pick<pg.ClientBase, "query">): Promise<RulesSnapshot["publicPayEmployers"]> {
  const r = (await db.query<{ data: unknown }>(PAY_DEALS, [new Date().toISOString().slice(0, 10)])).rows[0];
  if (!r) throw new Error("rules: no public_pay_employers version is in force");
  return payDealsOn(cleanData("public_pay_employers", r.data) as PayDealList);
}

/** The rules in force now (UTC day), never the cached copy: for the checks whose answer is saved (a post, an approval), so a change counts at once (B66). */
export const freshRules = (db: Pick<pg.ClientBase, "query">): Promise<RulesSnapshot> => loadRules(db, new Date().toISOString().slice(0, 10));

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
