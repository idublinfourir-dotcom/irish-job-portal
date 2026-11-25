// The posting form's logic (frames NE3, E10), pure so a unit test tries it with no browser: the form's state, the request bodies it makes for POST /api/portal/jobs, /jobs/edit
// and /jobs/check (docs/openapi/portal.yaml), what is still missing, the pay in words. No client code imports a server file; nothing here reads a database.

/** The 26 counties (the yaml's County enum; a unit test keeps the two the same). */
export const COUNTIES = ["Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow"] as const;

export type PayMode = "one" | "range" | "grade";
export type Form = {
  title: string; occupation: string; permitType: "critical_skills" | "general"; payMode: PayMode; salaryLow: string; salaryHigh: string; health: string; hours: string; grade: string;
  contractType: "" | "permanent" | "fixed_term"; months: string; county: string; description: string; ownPageUrl: string;
  employerIs: "self" | "client"; clientName: string; exception: boolean; statement: boolean; signerName: string; signerTitle: string; authority: boolean;
};
export const emptyForm = (): Form => ({
  title: "", occupation: "", permitType: "critical_skills", payMode: "one", salaryLow: "", salaryHigh: "", health: "", hours: "39", grade: "", contractType: "", months: "", county: "", description: "", ownPageUrl: "",
  employerIs: "self", clientName: "", exception: false, statement: false, signerName: "", signerTitle: "", authority: false,
});

/** One job of GET /api/portal/jobs/{id} (the fields the form fills from). */
export type JobDetail = {
  id: string; status: string; badge: string | null; title: string; description: string; county: string | null; occupationCode: string | null; contractType: "permanent" | "fixed_term" | null; contractMonths: number | null;
  salaryLow: number | null; salaryHigh: number | null; payGrade: string | null; healthInsuranceEur: number | null; weeklyHours: number; ownPageUrl: string | null; clientName: string | null;
  permitType: "critical_skills" | "general"; exceptionConfirmed: boolean; statement: { signerName: string; signerTitle: string; writtenAuthority: boolean } | null;
};
const s = (n: number | null | undefined) => (n === null || n === undefined ? "" : String(n));
/** The form filled from a job. A repost carries the text and the pay, never the old signature or the exception tick (they are given again for the new post). */
export function formFromJob(j: JobDetail, repost = false): Form {
  const grade = j.payGrade !== null && j.salaryLow === null;
  return {
    title: j.title, occupation: j.occupationCode ?? "", permitType: j.permitType, payMode: grade ? "grade" : j.salaryHigh !== null ? "range" : "one", salaryLow: s(j.salaryLow), salaryHigh: s(j.salaryHigh),
    health: s(j.healthInsuranceEur), hours: s(j.weeklyHours), grade: j.payGrade ?? "", contractType: j.contractType ?? "", months: s(j.contractMonths), county: j.county ?? "", description: j.description, ownPageUrl: j.ownPageUrl ?? "",
    employerIs: j.clientName ? "client" : "self", clientName: j.clientName ?? "", exception: repost ? false : j.exceptionConfirmed,
    statement: false, signerName: j.statement?.signerName ?? "", signerTitle: j.statement?.signerTitle ?? "", authority: false,
  };
}

/** Whole euros from what was typed ("36,000", "€ 36 000"); null for nothing typed; undefined for anything else. */
export function money(v: string): number | null | undefined {
  const t = v.replace(/[\s,€]/g, "");
  if (t === "") return null;
  return /^\d{1,7}$/.test(t) ? Number(t) : undefined;
}
/** The 4 digits at the start of what was typed in the occupation field ("2231" or "2231 Nurses"), or "". */
export const socOf = (v: string) => /^([1-9][0-9]{3})(?:\D|$)/.exec(v.trim())?.[1] ?? "";
/** The form with another occupation: an exception tick belongs to the role it was given for, so a change of code clears it. */
export const withOccupation = (f: Form, v: string): Form => ({ ...f, occupation: v, exception: f.exception && socOf(v) === socOf(f.occupation) });
const https = (v: string) => { try { const u = new URL(v.trim()); return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") && v.trim().length >= 10 && v.trim().length <= 500; } catch { return false; } };

export type Ctx = { agency: boolean; tier: number };
/** The pay modes this company is offered: the grade picker only for a public pay employer (tier above 0), never an agency (#39, CF98). */
export const payModes = (c: Ctx): PayMode[] => (c.tier > 0 && !c.agency ? ["one", "range", "grade"] : ["one", "range"]);

export type Missing = Partial<Record<"title" | "description" | "county" | "occupation" | "contractType" | "months" | "ownPageUrl" | "pay" | "hours" | "health" | "client" | "signer" | "authority", string>>;
const need = "Fill this in.";

/** What is wrong or missing before a live post (and the checks) can go: a message per field. Empty when nothing is. */
export function missing(f: Form, c: Ctx): Missing {
  const m: Missing = {};
  if (f.title.trim().length < 2) m.title = "Enter the job title (at least 2 characters).";
  if (f.description.trim().length < 20) m.description = "Describe the job in at least 20 characters.";
  if (!COUNTIES.includes(f.county as never)) m.county = "Choose the county.";
  if (!socOf(f.occupation)) m.occupation = "Pick the occupation by its four-digit code.";
  if (!f.contractType) m.contractType = need;
  if (f.contractType === "fixed_term" && !(Number(f.months) >= 1 && Number.isInteger(Number(f.months)) && Number(f.months) <= 600)) m.months = "Enter the length in months.";
  if (!https(f.ownPageUrl)) m.ownPageUrl = "Enter the address where candidates apply. It starts with https://.";
  const low = money(f.salaryLow), high = money(f.salaryHigh), hours = Number(f.hours), health = money(f.health);
  if (f.payMode === "grade") { if (!f.grade) m.pay = "Choose the pay-scale grade."; }
  else if (low === undefined || low === null || low < 1) m.pay = "Enter the salary in whole euros a year.";
  else if (f.payMode === "range" && (high === undefined || high === null || high < low)) m.pay = "Enter the top of the range. It cannot be below the bottom.";
  if (!(Number.isInteger(hours) && hours >= 1 && hours <= 60)) m.hours = "Enter hours a week, from 1 to 60.";
  if (health === undefined || (health !== null && health > 50_000)) m.health = "Enter whole euros a year, up to 50,000.";
  if (c.agency && f.employerIs === "client" && f.clientName.trim().length < 2) m.client = "Enter the client's name.";
  if (f.statement && (f.signerName.trim().length < 2 || f.signerTitle.trim().length < 2)) m.signer = "Enter the signer's name and role.";
  if (f.statement && c.agency && f.employerIs === "client" && !f.authority) m.authority = "Tick that you have the client's written authority.";
  return m;
}
export const ready = (f: Form, c: Ctx) => Object.keys(missing(f, c)).length === 0;

type Body = Record<string, unknown>;
/**
 * The request body. A live body is the whole post and needs `ready`; a draft body holds the title and only the fields that were filled in (a given field is checked like a live
 * one). `jobId` makes it an edit. The pay follows the mode: one amount, a range, or the grade alone (no typed salary). The statement goes only when its tick is on.
 */
export function bodyOf(f: Form, c: Ctx, status: "draft" | "live", jobId?: string): Body {
  const b: Body = { ...(jobId ? { jobId } : {}), status, title: f.title.trim(), permitType: f.permitType, weeklyHours: Number(f.hours) || 39 };
  const put = (k: string, v: unknown, on: boolean) => { if (on) b[k] = v; };
  put("description", f.description.trim(), f.description.trim() !== "");
  put("county", f.county, f.county !== "");
  put("occupationCode", socOf(f.occupation), socOf(f.occupation) !== "");
  put("contractType", f.contractType, f.contractType !== "");
  put("contractMonths", Number(f.months), f.contractType === "fixed_term" && f.months.trim() !== "");
  put("ownPageUrl", f.ownPageUrl.trim(), f.ownPageUrl.trim() !== "");
  const low = money(f.salaryLow), high = money(f.salaryHigh), health = money(f.health);
  if (f.payMode === "grade") put("payGrade", f.grade, f.grade !== "");
  else { put("salaryLow", low, typeof low === "number"); put("salaryHigh", high, f.payMode === "range" && typeof high === "number"); }
  put("healthInsuranceEur", health, f.payMode !== "grade" && typeof health === "number");
  put("exceptionConfirmed", true, f.exception);
  const client = c.agency && f.employerIs === "client";
  put("clientName", f.clientName.trim(), client && f.clientName.trim() !== "");
  put("statement", { signerName: f.signerName.trim(), signerTitle: f.signerTitle.trim(), ...(client ? { writtenAuthority: true } : {}) }, f.statement);
  return b;
}

const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
export const eur = (n: number) => EUR.format(n);
/** The pay line of the preview card, from what is typed. */
export function payLine(f: Form, grade?: { title: string; firstEur: number; lastEur: number }): string {
  if (f.payMode === "grade") return grade ? `${grade.title}: ${eur(grade.firstEur)} to ${eur(grade.lastEur)} a year` : "Public pay scale";
  const low = money(f.salaryLow), high = money(f.salaryHigh);
  if (typeof low !== "number") return "";
  return f.payMode === "range" && typeof high === "number" ? `${eur(low)} to ${eur(high)} a year` : `${eur(low)} a year`;
}

// ===== the live checks panel (B50): one row per check, in words, from the facts the route gives
export type Check = { id: string; state: "pass" | "note" | "blocked"; code?: string; detail?: Record<string, unknown> };
export type Row = { id: string; state: Check["state"]; title: string; text: string };
const num = (v: unknown) => (typeof v === "number" ? v : null);
const REASON: Record<string, string> = {
  GENERAL_RULES_NOT_SET: "The rules for General permit jobs are not set yet, so a General permit job cannot be posted now.",
  OCCUPATION_INELIGIBLE: "This role is on the Ineligible list. It can be posted only with an exception that applies to it.",
  QUOTA_FULL: "The quota for this role is full. Try again when it is renewed.",
  OCCUPATION_NOT_ON_LIST: "The role is not on the list of eligible occupations.",
  CONTRACT_TOO_SHORT: "The contract is shorter than the minimum. Change the length, or switch the permit type.",
  RULES_FAILED: "The advert text did not pass one of our checks. Read it again and fix what does not fit.",
  PAY_REQUIRED: "The job needs a stated salary.",
  PAY_BELOW_MINIMUM: "The pay is below the minimum.",
  PAY_NOT_ON_SCALE: "The pay is not on the scale of the grade you chose.",
  STATEMENT_REQUIRED: "A General permit job needs the sponsorship statement signed.",
};
export const reasonWord = (code: string | undefined) => (code ? REASON[code] ?? "This did not pass the rules in force." : "");

/** One check in words. Unknown ids still show (a title of "Check" and the reason), never a raw code. */
export function rowOf(c: Check): Row {
  const d = c.detail ?? {}, bad = c.state === "blocked", note = c.state === "note";
  const mk = (title: string, text: string): Row => ({ id: c.id, state: c.state, title, text });
  switch (c.id) {
    case "permit_rules": return mk("General permit rules", reasonWord("GENERAL_RULES_NOT_SET"));
    case "occupation":
      return bad ? mk("Occupation is on the Ineligible list", reasonWord(c.code ?? "OCCUPATION_INELIGIBLE")) : mk("Occupation is eligible", d.listStatus === "critical_skills" ? "On the Critical Skills list." : d.listStatus === "ineligible" ? "On the Ineligible list, with an exception you confirmed." : "Not on the Ineligible list.");
    case "condition": return mk(bad ? "Role condition to confirm" : "Role condition confirmed", typeof d.exception === "string" && d.exception ? d.exception : "The role has a condition.");
    case "quota": return d.full === true || bad ? mk("Quota is full", reasonWord("QUOTA_FULL")) : mk("Quota has room", "You can still publish.");
    case "list": return bad ? mk("Role is on no list", reasonWord(c.code ?? "OCCUPATION_NOT_ON_LIST")) : mk("Role can be posted", "It is not on the Ineligible list.");
    case "contract": {
      const min = num(d.minimumMonths);
      return bad ? mk("Contract is too short", min ? `A Critical Skills permit needs a contract of at least ${min} months. Change the length, or switch to a General permit.` : reasonWord("CONTRACT_TOO_SHORT")) : mk("Contract length", min ? `At least ${min} months is needed and this has it.` : "The length passes.");
    }
    case "wording": return bad ? mk("Advert text", reasonWord(c.code ?? "RULES_FAILED")) : mk("Advert text passes", "No wording that stops a post.");
    case "money": return note ? mk("Advert may ask for money", `A person checks the job before it goes live.${typeof d.phrase === "string" && d.phrase ? ` We found "${d.phrase}". Be specific about any fee the candidate pays.` : ""}`) : mk("Advert does not ask for money", "Nothing in the text asks candidates to pay.");
    case "pay": {
      const min = num(d.minimumEur), counted = num(d.countedEur);
      if (bad) return mk(c.code === "PAY_BELOW_MINIMUM" ? "Pay is below the minimum" : c.code === "PAY_NOT_ON_SCALE" ? "Pay is not on the scale" : "Pay needs to be stated", c.code === "PAY_BELOW_MINIMUM" && min !== null ? `The minimum is ${eur(min)} for ${num(d.weeklyHours) ?? 39} hours a week${counted !== null ? ` and ${eur(counted)} is counted` : ""}. Raise the pay, or add employer-paid health insurance.` : reasonWord(c.code));
      if (d.route === "public_pay") return mk("Public pay scale applies", "The salary minimum check is skipped for your company.");
      return mk("Pay clears the minimum", min !== null ? `The minimum is ${eur(min)}${counted !== null ? `; ${eur(counted)} is counted` : ""}${num(d.healthInsuranceEur) ? ` with ${eur(num(d.healthInsuranceEur)!)} health insurance` : ""}.` : "The pay passes.");
    }
    case "statement": return bad ? mk("Sponsorship statement needed", reasonWord("STATEMENT_REQUIRED")) : mk("Sponsorship statement signed", "The job will show Sponsor confirmed.");
    case "client": return d.found === true ? mk("Client found in permit records", "The client's name matches a name in the permit records.") : mk("Client not matched yet", "We could not match this client to the permit records, so a person checks the job before it goes live.");
    default: return mk("Check", reasonWord(c.code));
  }
}
export const blockedCount = (checks: readonly Check[]) => checks.filter((c) => c.state === "blocked").length;
