// The job alert email (step 11 part 11c, #236 Q1/D4/D5): built at send time from one `job_alert` outbox row, plain text.
// The row (made by 11b) is { run_on, alerts: [{ alert_id, job_ids }] }; this file only turns what the sender read into text and links.
// Stands alone for plain node (the outbox command runs without a bundler), so it cannot import soc.ts (a JSON import without an attribute)
// or search.ts (a directory import): it reads the same SOC data file for titles and keeps a copy of search.ts's salaryLine. Both copies are
// tested against the originals in packages/db/test/job-alert-email.test.ts.
import soc from "../../rules/data/soc2010-unit-groups.json" with { type: "json" };

const TITLES: ReadonlyMap<string, string> = new Map(soc.unit_groups.map((u) => [u.code, u.title]));
export const MAX_ALERTS = 10; // D1: the shared shape caps a row at 10 alerts and 20 jobs each; the reader applies the same caps to a hostile row
export const MAX_JOBS = 20;

export type AlertRow = {
  id: string; candidate_user_id: string; occupation_code: string | null; sector: string | null; county: string | null; salary_min: number | null;
  badge: string | null; frequency: string; unsubscribe_token: string;
};
export type JobRow = { id: string; title: string; employer_name: string; county: string | null; salary_low: number | null; salary_high: number | null; pay_grade: string | null };
export type RowAlert = { alertId: string; jobIds: string[] };

/** The row's `alerts`, read defensively (params is jsonb): whole-number ids only, at most 10 alerts and 20 jobs each. */
export function parseAlerts(params: unknown): RowAlert[] {
  const list = (params as { alerts?: unknown } | null)?.alerts;
  if (!Array.isArray(list)) return [];
  const id = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? String(v) : null);
  const out: RowAlert[] = [];
  for (const a of list.slice(0, MAX_ALERTS)) {
    const alertId = id((a as { alert_id?: unknown } | null)?.alert_id), jobs = (a as { job_ids?: unknown } | null)?.job_ids;
    if (alertId && Array.isArray(jobs)) out.push({ alertId, jobIds: jobs.slice(0, MAX_JOBS).map(id).filter((j): j is string => j !== null) });
  }
  return out;
}

/** Copy of search.ts salaryLine (the job list's pay text). */
export function salaryLine(low: number | null, high: number | null, payGrade: string | null): string | null {
  const eur = (n: number) => `€${new Intl.NumberFormat("en-IE").format(n)}`;
  if (low !== null && high !== null) return low === high ? eur(low) : `${eur(low)} to ${eur(high)}`;
  if (low !== null) return `From ${eur(low)}`;
  if (high !== null) return `Up to ${eur(high)}`;
  return payGrade || null;
}

/** Fetched or typed text on one line: control and format characters (new lines, bidi marks, zero-width) become spaces. */
const line = (s: string | null | undefined) => (s ?? "").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim();

export function filtersInWords(a: AlertRow): string {
  const occupation = a.occupation_code && [line(TITLES.get(a.occupation_code)), `(${line(a.occupation_code)})`].filter((x) => x !== "").join(" ");
  const parts = [
    occupation && `occupation ${occupation}`,
    a.sector && `sector ${line(a.sector)}`,
    a.county && `county ${line(a.county)}`,
    a.salary_min !== null && `pay from €${new Intl.NumberFormat("en-IE").format(a.salary_min)} a year`,
    a.badge === "sponsor_confirmed" && "only employers with a confirmed sponsor",
  ].filter(Boolean);
  return `${parts.length ? parts.join(", ") : "all new jobs"} (${a.frequency === "weekly" ? "weekly" : "daily"})`;
}

const link = (site: string, token: string, scope: "one" | "all") => `${site}/api/alerts/unsubscribe?token=${encodeURIComponent(token)}&scope=${scope}`;

/** SITE_URL as an https origin (no path, no login in it), or null. */
export function siteOrigin(v: string | undefined): string | null {
  try { const u = new URL(v ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.origin : null; } catch { return null; }
}

/**
 * The email for one row. `alerts` are the row's, `found` the active alerts read from the database, `live` the jobs still live.
 * An alert not in `found` or owned by another candidate is left out, and so is a job not in `live`. Null when nothing is left.
 */
export function buildAlertEmail(candidate: string, alerts: RowAlert[], found: Map<string, AlertRow>, live: Map<string, JobRow>, site: string) {
  const blocks: string[] = [];
  let first: AlertRow | undefined;
  for (const r of alerts) {
    const a = found.get(r.alertId);
    if (!a || a.candidate_user_id !== candidate) continue;
    const jobs = r.jobIds.map((id) => live.get(id)).filter((j): j is JobRow => !!j);
    if (!jobs.length) continue;
    first ??= a;
    const lines = jobs.map((j) => `- ${[line(j.title), line(j.employer_name), line(j.county), salaryLine(j.salary_low, j.salary_high, j.pay_grade)].filter(Boolean).join(", ")}\n  ${site}/jobs/${j.id}`);
    blocks.push(`Your alert: ${filtersInWords(a)}\n${lines.join("\n")}\nStop this alert: ${link(site, a.unsubscribe_token, "one")}`);
  }
  if (!first) return null;
  const all = link(site, first.unsubscribe_token, "all");
  return {
    subject: "New jobs matching your job alerts",
    text: `PLACEHOLDER WORDING.\n\nThese new jobs match your job alerts.\n\n${blocks.join("\n\n")}\n\nStop all your job alerts: ${all}\n`,
    headers: { "List-Unsubscribe": `<${all}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
}
