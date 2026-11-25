// The pure parts of the rules data pages (frames ND3, D05, D06): tab names, the words for a kind, a change as lines of text, the minimums table, dates and euro. No database, no React.
import type { Pending, Version } from "@portal/db";

export const KIND_LABEL: Record<string, string> = {
  minimums: "Salary minimums", critical_skills_list: "Critical Skills list", ineligible_list: "Ineligible list", public_pay_employers: "Pay-deal employers",
  big_company_names: "Big-company list", pay_scales: "Public pay scales", big_company_flag: "Big-company flag on a company",
};
/** The `kind` of the history page: the six kinds a version is kept for. */
export const HISTORY_KINDS = ["minimums", "critical_skills_list", "ineligible_list", "pay_scales", "public_pay_employers", "big_company_names"] as const;
export type Tab = "minimums" | "critical" | "ineligible" | "quotas" | "scales" | "history";
export const TABS: readonly (readonly [Tab, string])[] = [["minimums", "Salary minimums"], ["critical", "Critical Skills list"], ["ineligible", "Ineligible list"], ["quotas", "Quotas"], ["scales", "Public pay scales"]];
export const KIND_OF_TAB: Record<Exclude<Tab, "history" | "quotas">, string> = { minimums: "minimums", critical: "critical_skills_list", ineligible: "ineligible_list", scales: "pay_scales" };
/** The tab asked for; a repeated, missing or unknown value is the first tab (a hostile `?tab=` never reaches a read). */
export const tabOf = (v: string | undefined): Tab => (TABS.some(([t]) => t === v) || v === "history" ? (v as Tab) : "minimums");
export const historyKind = (v: string | undefined): string => ((HISTORY_KINDS as readonly string[]).includes(v ?? "") ? v! : "minimums");

const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
/** "1 Jan 2027" from a day text ("2027-01-01"); anything else comes back as it is. */
export const dayText = (d: string | null | undefined): string => (d && /^\d{4}-\d\d-\d\d/.test(d) ? DAY.format(new Date(`${d.slice(0, 10)}T00:00:00Z`)) : (d ?? ""));
/** Today's day in Ireland as "2026-11-25": the earliest day a rules change can start on (the route refuses an earlier one). */
export const isoDay = (now: Date): string => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin" }).format(now);
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const eur = (n: number): string => `€${n.toLocaleString("en-IE")}`;

// ===== the minimums table =====
type Mins = Record<string, unknown> & { graduateMonths?: number; nonListRoute?: boolean };
const MIN_ROWS: { key: string; permit: string; text: (m: Mins) => string }[] = [
  { key: "criticalSkills", permit: "Critical Skills", text: () => "A role on the Critical Skills list" },
  { key: "graduate", permit: "Critical Skills", text: (m) => `Same, a graduate of the last ${m.graduateMonths ?? "?"} months` },
  { key: "nonList", permit: "Critical Skills", text: (m) => `Any role not on the Ineligible list${m.nonListRoute === false ? " (this route is switched off)" : ""}` },
  { key: "general", permit: "General", text: () => "Most roles" },
  { key: "generalLower", permit: "General", text: () => "The roles at the lower rate" },
];
export const MIN_FIELD: Record<string, string> = {
  criticalSkills: "Critical Skills minimum", graduate: "Graduate minimum", graduateMonths: "Graduate months", nonList: "Not-on-a-list minimum", nonListRoute: "Not-on-a-list route",
  minContractMonths: "Shortest contract (months)", standardWeekHours: "Standard week (hours)", checkedOn: "Source checked on", general: "General minimum", generalLower: "General lower rate",
  generalLowerCodes: "Codes at the lower rate", generalQuotaFullCodes: "Codes with a full quota",
};
export type MinRow = { permit: string; text: string; now: number; hourly: number | null; from: string; checked: string; next: number | null; nextFrom: string | null };
/** One row per figure the version in force holds (a General figure only when the version has it); the next value and its day come from the first confirmed version still to come. */
export function minimumRows(inForce: Version | undefined, upcoming: Version[]): MinRow[] {
  if (!inForce) return [];
  const d = inForce.data as unknown as Mins, up = upcoming.filter((u) => u.kind === "minimums").sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))[0];
  const nd = up?.data as unknown as Mins | undefined;
  return MIN_ROWS.filter((r) => typeof d[r.key] === "number").map((r) => ({
    permit: r.permit, text: r.text(d), now: d[r.key] as number, hourly: inForce.hourly?.[r.key] ?? null, from: inForce.effectiveFrom, checked: String(d.checkedOn ?? ""),
    next: typeof nd?.[r.key] === "number" ? (nd[r.key] as number) : null, nextFrom: up && typeof nd?.[r.key] === "number" ? up.effectiveFrom : null,
  }));
}

// ===== a change as lines of text (the proposal, the history) =====
const brief = (v: unknown): string => {
  if (v === null || v === undefined) return "none";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}...` : v;
  if (Array.isArray(v)) return v.length > 6 ? `${v.slice(0, 6).join(", ")} and ${v.length - 6} more` : v.join(", ");
  const o = v as Record<string, unknown>;
  const s = typeof o.title === "string" ? `${typeof o.code === "string" ? `${o.code} ` : ""}${o.title}` : typeof o.name === "string" ? o.name : typeof o.bodyType === "string" ? String(o.bodyType) : JSON.stringify(v);
  return s.length > 100 ? `${s.slice(0, 97)}...` : s;
};
const label = (k: string) => MIN_FIELD[k] ?? k;
export type ChangeLike = { added?: Record<string, unknown>; removed?: Record<string, unknown>; changed?: Record<string, { before: unknown; after: unknown }> };
export const CHANGE_LINES = 30;
/** Each added, removed and changed entry as one line; at most CHANGE_LINES, then "and N more". */
export function changeLines(c: ChangeLike): string[] {
  const all = [
    ...Object.entries(c.added ?? {}).map(([k, v]) => `Added ${label(k)}: ${brief(v)}`),
    ...Object.entries(c.removed ?? {}).map(([k, v]) => `Removed ${label(k)}: ${brief(v)}`),
    ...Object.entries(c.changed ?? {}).map(([k, v]) => `Changed ${label(k)}: ${brief(v.before)} to ${brief(v.after)}`),
  ];
  return all.length > CHANGE_LINES ? [...all.slice(0, CHANGE_LINES), `and ${all.length - CHANGE_LINES} more changes`] : all;
}

/** The proposals waiting for one page: those of its kinds. */
export const pendingFor = (all: Pending[], kinds: string[]): Pending[] => all.filter((p) => kinds.includes(p.kind));

export const BODY_LABEL: Record<string, string> = { public_body: "Public body", section_38: "Section 38", section_39: "Section 39" };
export const EVIDENCE_LABEL: Record<string, string> = { service_arrangement: "Service arrangement", published_pay_policy: "Published pay policy", dete_rule_text: "DETE rule text", other: "Other" };
export const TEST_LABEL: Record<string, string> = { brand: "A well-known brand", "250_staff": "250 or more staff", dete_steady_sponsor: "A steady DETE sponsor" };
