// The pure parts of the manual posting page (frame D10): the body the form sends (POST /api/manual-jobs and /api/manual-jobs/dry-run in docs/openapi/admin.yaml), and the checks panel's words.
// No database, no React. Staff post Critical Skills jobs only and never create a company (#287, L39); "Sponsor confirmed" is the later two-person step on a live post.
import { adminWords } from "../_queue/words-adm";

export const COUNTIES = ["Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow"] as const;

/** A "Sponsor confirmed" upload waiting on a post: the fields of the read (readSponsorConfirmations) the page shows. */
export type SponsorPending = { requestId: string; jobId: string; fileName: string; proposedBy: string; proposedByName: string | null };

export type Built = { ok: true; body: Record<string, unknown> } | { ok: false; error: string };
const s = (f: FormData, k: string): string => String(f.get(k) ?? "").trim();
const whole = (f: FormData, k: string): number | null | "bad" => (s(f, k) === "" ? null : /^\d{1,7}$/.test(s(f, k)) ? Number(s(f, k)) : "bad");

/** The create body (without `action`) from the form: a blank optional number is null (a blank contract is permanent). The route checks every field again and names what is wrong. */
export function manualBody(f: FormData, organisationId: string | null): Built {
  if (organisationId === null) return { ok: false, error: "Pick the employer first." };
  const [months, low, high, ins, hours] = [whole(f, "contractMonths"), whole(f, "salaryLow"), whole(f, "salaryHigh"), whole(f, "healthInsuranceEur"), whole(f, "weeklyHours")];
  if ([months, low, high, ins, hours].includes("bad")) return { ok: false, error: "The contract months, pay, health insurance and hours are whole numbers." };
  if (hours === null) return { ok: false, error: "Give the weekly hours." };
  return {
    ok: true,
    body: {
      organisationId, title: s(f, "title"), description: String(f.get("description") ?? "").trim(), county: s(f, "county"), occupationCode: s(f, "occupationCode"), contractMonths: months,
      salaryLow: low, salaryHigh: high, payGrade: s(f, "payGrade") || null, healthInsuranceEur: ins, weeklyHours: hours, closesOn: s(f, "closesOn"), applyUrl: s(f, "applyUrl"),
    },
  };
}

export type Check = { id: string; state: "pass" | "blocked"; code?: string; detail: Record<string, string | number | boolean | null> };
export type DryRun = { status: "live" | "draft"; badge: string | null; passRoute: string | null; reason: { code: string; stage?: string } | null; closesAt: string; checks: Check[] };
export const CHECK_TITLE: Record<string, string> = { occupation: "Occupation eligible", contract: "Contract length", wording: "Advert wording", money: "No request for money", pay: "Salary" };
const eur = (n: unknown) => `€${Number(n).toLocaleString("en-IE")}`;
/** What one check found, in words: the route's facts for a pass, the sentence for its code when blocked. */
export function checkText(c: Check): string {
  const d = c.detail;
  if (c.state === "blocked") {
    const why = adminWords(c.code ?? "", 400, typeof d.stage === "string" ? d.stage : undefined);
    return c.id === "pay" && typeof d.minimumEur === "number" ? `${why} The minimum is ${eur(d.minimumEur)}, counted pay is ${eur(d.countedEur)}.` : why;
  }
  if (c.id === "occupation") return `${d.list === "critical_skills" ? "On the Critical Skills list" : "Eligible"} (code ${d.occupationCode})`;
  if (c.id === "contract") return d.months === null ? "Permanent" : `${d.months} months, at least ${d.minimumMonths} needed`;
  if (c.id === "wording") return "The advert text passes the rules.";
  if (c.id === "money") return "The advert does not ask the candidate for money.";
  return d.route === "public_pay" ? "A public pay employer on a list role: the pay scale applies." : `${eur(d.countedEur)} clears ${eur(d.minimumEur)}`;
}
/** The one line over the checks: what posting now would do. */
export const verdict = (r: DryRun): string =>
  r.status === "live" ? "It would be listed now, with the Critical Skills eligible badge." : `It would stay a draft and not be listed${r.reason ? `: ${adminWords(r.reason.code, 400, r.reason.stage)}` : ""}`;

export const STATUS_LABEL: Record<string, string> = { live: "Live", draft: "Draft, not listed", closed: "Closed" };
export const statusLabel = (s: string): string => STATUS_LABEL[s] ?? s;
