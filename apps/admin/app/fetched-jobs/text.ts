// The words of the fetched-job queue page, pure so a test covers them. The stage texts are the rules chain's own (packages/rules/src/types.ts); a tab is one stage text (Q15).
import type { DryRun } from "@portal/db";

/** "7 contract unclear (admin queue)" becomes "Contract unclear": the number and the bracket are for the rules, not for the reader. */
export function stageLabel(stage: string | null): string {
  if (stage === null) return "No advert record";
  const t = stage.replace(/^\d+\s+/, "").replace(/\s*\((admin queue)[^)]*\)\s*$/, "").trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : "Queued";
}
export const sourceLabel = (kind: string): string => kind.replaceAll("_", " ");
export const initials = (name: string): string => {
  const w = name.split(/\s+/).filter((x) => /^\p{L}/u.test(x));
  return (w.length > 1 ? w[0]![0]! + w[1]![0]! : (w[0] ?? "?").slice(0, 2)).toUpperCase();
};

export const CHECK_TITLE: Record<string, string> = {
  irish_employer: "Irish employer",
  sponsorship_wording: "Exclusion words",
  occupation_known: "Occupation",
  critical_skills_list: "Critical Skills list",
  contract: "Contract",
  salary: "Salary",
  scam_wording: "Scam wording",
};
export type Row = { title: string; ok: boolean | null; text: string };

/** The check list of the detail card: each rules check in order, then the quota and the pay grade the job already has. */
export function checkRows(d: DryRun): Row[] {
  const rows = d.checks.map((c): Row => ({
    title: CHECK_TITLE[c.check] ?? c.check.replaceAll("_", " "),
    ok: c.result === "pass" ? true : c.result === "not_run" ? null : false,
    text:
      c.result === "not_run" ? "Not reached: an earlier check stopped it."
      : c.result === "unsure" ? `Unsure, so a person decides.${c.detail ? ` ${c.detail}` : ""}`
      : c.detail ?? (c.result === "pass" ? "Passed." : "Did not pass."),
  }));
  rows.push({ title: "Quota", ok: !d.quotaFull, text: d.quotaFull ? "The quota for this occupation is full." : "No quota stop for this occupation." });
  if (d.payGrade) rows.push({ title: "Pay-scale grade", ok: true, text: d.payGrade });
  return rows;
}

// Reject reason codes. The route takes any lower-case code (the audit log holds codes, never free text, #182); placeholder wording until the owner fixes the real list.
export const REJECT_REASONS: readonly [string, string][] = [
  ["not_critical_skills", "Not a Critical Skills occupation"],
  ["not_irish_employer", "Not an Irish employer"],
  ["contract_too_short", "Contract under the minimum"],
  ["salary_too_low", "Pay under the minimum"],
  ["scam_or_fake", "Looks like a scam or a fake advert"],
  ["duplicate", "Duplicate of another job"],
  ["other", "Another reason"],
];

/** The three numbers a check form sends in the address: a code of 4 digits and pay of 1 to 7 digits; anything else is dropped, not passed on. */
export function readCheckParams(q: { soc?: string; low?: string; high?: string; contract?: string }) {
  const soc = q.soc !== undefined && /^\d{4}$/.test(q.soc) ? q.soc : undefined;
  const pay = (v?: string) => (v !== undefined && /^\d{1,7}$/.test(v) ? Number(v) : undefined);
  return { soc, low: pay(q.low), high: pay(q.high), contract: q.contract === "1" };
}
