// The rules in force on one day (#229), passed in as data. Every runtime path takes its minimums and lists from a snapshot; the constants in
// thresholds.ts and the lists in employers/brand.ts are version 1 (the seed and the tests read them). Today the snapshot is built from those
// constants and the two data files; the apps and the fetch read the rules in force from the database (getRules in packages/db/src/rules-data.ts); rulesV1() in current.ts is version 1.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BIG_COMPANY_BRANDS, BIG_COMPANY_LIST_150 } from "./employers/brand";
import type { PublicPayCandidates } from "./employers/public-pay";
import {
  CRITICAL_SKILLS_MINIMUM, GRADUATE_MINIMUM, GRADUATE_MONTHS, MIN_CONTRACT_MONTHS, NON_LIST_MINIMUM, NON_LIST_ROUTE, RULES_CHECKED_ON, STANDARD_WEEK_HOURS,
} from "./thresholds";

export type Minimums = {
  criticalSkills: number;    // today CRITICAL_SKILLS_MINIMUM, 40904
  graduate: number;          // today GRADUATE_MINIMUM, 36848
  graduateMonths: number;    // today GRADUATE_MONTHS, 12
  nonList: number;           // today NON_LIST_MINIMUM, 68911
  nonListRoute: boolean;     // today NON_LIST_ROUTE, true
  minContractMonths: number; // today MIN_CONTRACT_MONTHS, 24
  standardWeekHours: number; // today STANDARD_WEEK_HOURS, 39
  checkedOn: string;         // today RULES_CHECKED_ON, "2026-11-12"
  // General Employment Permit posting (S.I. 643/2025 Schedule 8). All four or none: version 1 has none, so a General post is refused until a version has them.
  general?: number;               // the standard minimum, GENERAL_MINIMUM
  generalLower?: number;          // the lower rate, GENERAL_LOWER_MINIMUM
  generalLowerCodes?: string[];   // four-digit codes at the lower rate, GENERAL_LOWER_CODES
  generalQuotaFullCodes?: string[]; // four-digit codes whose quota is full: no new General posts (#85); may be empty
};
export type RulesSnapshot = {
  minimums: Minimums;
  /** packages/fetcher/data/occupation-lists.json as it is. */
  occupationLists: readonly { id: string; code: string; title: string; list: "critical-skills" | "ineligible" }[];
  /** packages/fetcher/data/L2/public_employers_candidates.json as it is. */
  publicPayEmployers: Readonly<Record<string, { tier: 1 | 2; note?: string }>>;
  /** Cleaned names, matched as isBigCompany does today: BIG_COMPANY_BRANDS then BIG_COMPANY_LIST_150, in that order. */
  bigCompanyNames: readonly string[];
  /** Public pay scales by grade (#269, #67), when a version of that kind is in force (none before the engineer's first one). */
  payScales?: readonly PayScale[];
};
/** The grade's scale in the version in force (#269) when `payGrade` is one of its codes; otherwise (free text, no version) undefined. */
export const payScaleOf = (r: RulesSnapshot, payGrade: string | null): PayScale | undefined => (payGrade === null ? undefined : r.payScales?.find((g) => g.code === payGrade));
/**
 * The #269 rule on the public pay route (#67), for an employer post and a staff manual post alike: stated pay off the listed grade's scale (any point counts;
 * the low and, when given, the high must lie between the first and last point). A free-text grade, no version or no stated pay is never off the scale.
 */
export function offScale(r: RulesSnapshot, payGrade: string | null, low: number | null, high: number | null): boolean {
  const s = payScaleOf(r, payGrade);
  return !!s && low !== null && (low < s.firstEur || (high ?? low) > s.lastEur);
}
/** One grade's pay scale (#269): the first and last point in euro a year, and the page it was read on. `note` is placeholder wording. */
export type PayScale = { code: string; title: string; firstEur: number; lastEur: number; sourceUrl: string; sourcePage: number; note?: string };

/** Version 1 of the minimums: today's constants. */
export const MINIMUMS_V1: Minimums = {
  criticalSkills: CRITICAL_SKILLS_MINIMUM, graduate: GRADUATE_MINIMUM, graduateMonths: GRADUATE_MONTHS, nonList: NON_LIST_MINIMUM, nonListRoute: NON_LIST_ROUTE,
  minContractMonths: MIN_CONTRACT_MONTHS, standardWeekHours: STANDARD_WEEK_HOURS, checkedOn: RULES_CHECKED_ON,
};
/** Version 1 of the big-company names, in matching order. */
export const BIG_COMPANY_NAMES_V1: readonly string[] = [...BIG_COMPANY_BRANDS, ...BIG_COMPANY_LIST_150];

/** Version 1 minimums and names with the two lists given (the files, as read). */
export const snapshotOf = (occupationLists: unknown, publicPayEmployers: unknown): RulesSnapshot => ({
  minimums: MINIMUMS_V1,
  occupationLists: occupationLists as RulesSnapshot["occupationLists"],
  publicPayEmployers: publicPayEmployers as RulesSnapshot["publicPayEmployers"],
  bigCompanyNames: BIG_COMPANY_NAMES_V1,
});

const readJson = (file: string): unknown => JSON.parse(readFileSync(file, "utf8"));
/** The stand-in loader: today's constants and the two files under `dir` (`occupation-lists.json`, `L2/public_employers_candidates.json`), as the fetch reads them. */
export const rulesFromFiles = (dir: string): RulesSnapshot =>
  snapshotOf(readJson(join(dir, "occupation-lists.json")), readJson(join(dir, "L2", "public_employers_candidates.json")));

/** Throws when a list is empty or a minimum is missing or not positive (#229: the fetch saves nothing on bad rules). Returns the snapshot. */
export function checkSnapshot(s: RulesSnapshot): RulesSnapshot {
  const m = (s?.minimums ?? {}) as Partial<Record<keyof Minimums, unknown>>;
  for (const k of ["criticalSkills", "graduate", "graduateMonths", "nonList", "minContractMonths", "standardWeekHours"] as const) {
    const v = m[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new Error(`rules: the minimum ${k} is missing or not positive`);
  }
  if (typeof m.nonListRoute !== "boolean") throw new Error("rules: nonListRoute is missing");
  if (typeof m.checkedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(m.checkedOn)) throw new Error("rules: checkedOn is missing");
  const lists = Array.isArray(s.occupationLists) ? s.occupationLists : [];
  if (!lists.some((e) => e.list === "critical-skills")) throw new Error("rules: the Critical Skills list is empty");
  if (!lists.some((e) => e.list === "ineligible")) throw new Error("rules: the Ineligible list is empty");
  if (!s.publicPayEmployers || Object.keys(s.publicPayEmployers).length === 0) throw new Error("rules: the public pay employers list is empty");
  if (!Array.isArray(s.bigCompanyNames) || s.bigCompanyNames.length === 0) throw new Error("rules: the big-company names list is empty");
  if (s.payScales !== undefined && (!Array.isArray(s.payScales) || s.payScales.length === 0)) throw new Error("rules: the pay scales list is empty");
  return s;
}

/** The public pay candidates the chain reads (`publicPayTier`), from the snapshot. */
export const publicPayCandidatesOf = (s: RulesSnapshot): PublicPayCandidates =>
  new Map(Object.entries(s.publicPayEmployers).map(([k, v]) => [k, v.tier]));

/** What the rules chain takes from the snapshot (ChainData without the DETE names and the matcher). */
export const chainRules = (s: RulesSnapshot) => ({ minimums: s.minimums, bigCompanyNames: s.bigCompanyNames, publicPayCandidates: publicPayCandidatesOf(s) });

/** Version 1 of what the chain takes from the snapshot besides the public pay candidates (the gate, the parity runs and tests). */
export const CHAIN_RULES_V1 = { minimums: MINIMUMS_V1, bigCompanyNames: BIG_COMPANY_NAMES_V1 } as const;
