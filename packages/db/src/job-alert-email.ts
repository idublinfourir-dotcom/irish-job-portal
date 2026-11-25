// The job alert email (step 11 part 11c, #236 Q1/D4/D5): built at send time from one `job_alert` outbox row, HTML plus plain text in the
// shared layout (E1). Draft wording until the content writers' final text (N2 stays open).
// The row (made by 11b) is { run_on, alerts: [{ alert_id, job_ids }] }; this file only turns what the sender read into text and links.
// Stands alone for plain node (the outbox command runs without a bundler), so it cannot import soc.ts (a JSON import without an attribute)
// or search.ts (a directory import): it reads the same SOC data file for titles and keeps a copy of search.ts's salaryLine. Both copies are
// tested against the originals in packages/db/test/job-alert-email.test.ts.
import soc from "../../rules/data/soc2010-unit-groups.json" with { type: "json" };
import { C, esc, FONT, href, linkHtml, pillHtml, render, SITE_NAME, SMALL } from "../../auth/src/email-layout.ts";

const TITLES: ReadonlyMap<string, string> = new Map(soc.unit_groups.map((u) => [u.code, u.title]));
export const MAX_ALERTS = 10; // D1: the shared shape caps a row at 10 alerts and 20 jobs each; the reader applies the same caps to a hostile row
export const MAX_JOBS = 20;

export type AlertRow = {
  id: string; candidate_user_id: string; occupation_code: string | null; sector: string | null; county: string | null; salary_min: number | null;
  badge: string | null; frequency: string; unsubscribe_token: string;
};
export type JobRow = { id: string; title: string; employer_name: string; county: string | null; salary_low: number | null; salary_high: number | null; pay_grade: string | null; badge: string | null };
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

const NUM = new Intl.NumberFormat("en-IE"); // made once: a new formatter per job made the largest alert (10 by 20) take 19 ms instead of 1.4 ms
/** Copy of search.ts salaryLine (the job list's pay text). */
export function salaryLine(low: number | null, high: number | null, payGrade: string | null): string | null {
  const eur = (n: number) => `€${NUM.format(n)}`;
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
    a.salary_min !== null && `pay from €${NUM.format(a.salary_min)} a year`,
    a.badge === "sponsor_confirmed" && "only employers with a confirmed sponsor",
  ].filter(Boolean);
  return `${parts.length ? parts.join(", ") : "all new jobs"} (${a.frequency === "weekly" ? "weekly" : "daily"})`;
}

const BADGES: Record<string, { label: string; word: string; bg: string; ink: string }> = {
  critical_skills_eligible: { label: "Critical Skills eligible", word: "Critical", bg: C.critical, ink: C.criticalInk },
  sponsor_confirmed: { label: "Sponsor confirmed", word: "Sponsor", bg: C.sponsor, ink: C.sponsorInk },
};
/** A job's pay for the alert row: the number line, or the public pay scale label (with its grade) when the job has only a grade. */
export const payText = (j: JobRow): string | null =>
  j.salary_low !== null || j.salary_high !== null ? salaryLine(j.salary_low, j.salary_high, null) : line(j.pay_grade) ? `Public pay scale (${line(j.pay_grade)})` : null;

/** A short name for an alert, from its filters (alerts have no name of their own): "Nurses in Cork", at most 40 characters; null for "all new jobs". */
export function alertName(a: AlertRow): string | null {
  const base = (a.occupation_code && line(TITLES.get(a.occupation_code))) || line(a.sector), county = line(a.county);
  const name = [base, county && (base ? `in ${county}` : county)].filter(Boolean).join(" ");
  return name ? (name.length > 40 ? `${name.slice(0, 37)}...` : name) : null;
}

/** The alert's own results page: the same keys search.ts reads (a test holds this equal to search.ts searchParams). */
export function resultsUrl(site: string, a: AlertRow): string {
  const q = new URLSearchParams();
  for (const [k, v] of [["occupationCode", a.occupation_code], ["sector", a.sector], ["county", a.county], ["salaryMin", a.salary_min], ["badge", a.badge]] as const)
    if (v !== null && v !== "") q.set(k, String(v));
  return `${site}/jobs${q.size ? `?${q}` : ""}`;
}
/** The candidate's alert page opens this alert for editing (the page is built in step 16 P17; the id is the alert's own number). */
export const editUrl = (site: string, a: AlertRow) => `${site}/account/alerts?edit=${encodeURIComponent(a.id)}`;

const query = (token: string, scope: "one" | "all") => `token=${encodeURIComponent(token)}&scope=${scope}`;
/** The page the email's Stop links open (the candidate site's /unsubscribe: it asks, then confirms). */
const link = (site: string, token: string, scope: "one" | "all") => `${site}/unsubscribe?${query(token, scope)}`;
/** The API address of the RFC 8058 List-Unsubscribe header: the mail provider's one-click POST goes here, not to the page. */
const oneClick = (site: string, token: string) => `${site}/api/alerts/unsubscribe?${query(token, "all")}`;

/** SITE_URL as an https origin (no path, no login in it), or null. */
export function siteOrigin(v: string | undefined): string | null {
  try { const u = new URL(v ?? ""); return u.protocol === "https:" && !u.username && !u.password ? u.origin : null; } catch { return null; }
}

/**
 * The email for one row. `alerts` are the row's, `found` the active alerts read from the database, `live` the jobs still live.
 * An alert not in `found` or owned by another candidate is left out, and so is a job not in `live`. Null when nothing is left.
 */
export function buildAlertEmail(candidate: string, alerts: RowAlert[], found: Map<string, AlertRow>, live: Map<string, JobRow>, site: string) {
  const blocks: string[] = [], html: string[] = [], seen = new Set<string>(), shown: AlertRow[] = [];
  for (const r of alerts) {
    const a = found.get(r.alertId);
    if (!a || a.candidate_user_id !== candidate) continue;
    const jobs = r.jobIds.map((id) => live.get(id)).filter((j): j is JobRow => !!j);
    if (!jobs.length) continue;
    shown.push(a);
    jobs.forEach((j) => seen.add(j.id));
    const facts = (j: JobRow) => [line(j.employer_name), line(j.county), payText(j)].filter(Boolean).join(", ");
    const badge = (j: JobRow) => BADGES[j.badge ?? ""];
    const lines = jobs.map((j) => `- ${[line(j.title), facts(j), badge(j)?.label].filter(Boolean).join(", ")}\n  ${site}/jobs/${j.id}`);
    const results = resultsUrl(site, a), edit = editUrl(site, a), stop = link(site, a.unsubscribe_token, "one");
    blocks.push(`Your alert: ${filtersInWords(a)}\n${lines.join("\n")}\nSee these jobs: ${results}\nEdit this alert: ${edit}\nStop this alert: ${stop}`);
    html.push(
      `<p style="margin:12px 0 8px;font-size:14px;line-height:20px;font-weight:600;color:${C.ink};${FONT}">Your alert: ${esc(filtersInWords(a))}</p>` +
      jobs.map((j) => `<p style="margin:0 0 12px;font-size:16px;line-height:22px;color:${C.ink}"><a href="${href(`${site}/jobs/${j.id}`)}" style="color:${C.link}">${esc(line(j.title) || "A job")}</a>` +
        `${badge(j) ? ` ${pillHtml(badge(j)!.word, badge(j)!.bg, badge(j)!.ink)}` : ""}<br><span style="font-size:14px">${esc(facts(j))}</span></p>`).join("") +
      `<p style="${SMALL}">${linkHtml(results, "See these jobs")} &middot; ${linkHtml(edit, "Edit this alert")} &middot; ${linkHtml(stop, "Stop this alert")}</p>`,
    );
  }
  const first = shown[0];
  if (!first) return null;
  const all = link(site, first.unsubscribe_token, "all"), n = seen.size, name = shown.length === 1 ? alertName(first) : null;
  const m = render(`${n} new ${n === 1 ? "job" : "jobs"}${shown.length > 1 ? ` from ${shown.length} of your alerts` : name ? `: ${name}` : ""}`, {
    heading: `${n} new ${n === 1 ? "job" : "jobs"} for you`,
    paragraphs: ["These jobs were added since your last alert and match what you asked for."],
    extra: {
      html: `${html.join("")}<p style="${SMALL}">${linkHtml(all, "Stop all your job alerts")}</p>`,
      text: `${blocks.join("\n\n")}\n\nStop all your job alerts: ${all}`,
    },
    button: shown.length === 1 ? { label: "See all new jobs", url: resultsUrl(site, first) } : { label: "See all jobs", url: `${site}/jobs` },
    footer: `You got this email because you set up a job alert on ${SITE_NAME}. Use the links above to change one alert, stop one, or stop all of them.`,
  });
  return { ...m, headers: { "List-Unsubscribe": `<${oneClick(site, first.unsubscribe_token)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } };
}
