// The words of the employer job pages (frames NE2, E08, E13): every job state, hold reason and rules code, the day counts, and one sentence for every answer of the
// routes these pages call (docs/openapi/portal.yaml). Pure, so a unit test tries every status and code. `status` 0 is "no answer" (offline). No client code imports a server file.
import type { Answer } from "../(auth)/messages";

/** One row of GET /api/portal/jobs (the fields these pages read). */
export type Job = {
  id: string; title: string; status: string; permitType: string; applicationRoute: string; hasOwnPage: boolean; county: string | null; postedAt: string; closesAt: string | null;
  closedAt: string | null; closeReason: string | null; hireAnswer: string | null; reason: string | null; reviewCode: string | null; exceptionConfirmed: boolean; clientCheck: boolean;
};

/** What a job is to its owner: the database status refined by why it closed. */
export type JobState = "draft" | "in_review" | "live" | "under_review" | "hidden" | "expired" | "closed" | "removed";
export const jobState = (j: Pick<Job, "status" | "closeReason">): JobState => {
  if (j.status !== "closed") return (["draft", "in_review", "live", "under_review", "hidden"].includes(j.status) ? j.status : "closed") as JobState;
  return j.closeReason === "expired" || j.closeReason === "under_review_expired" ? "expired" : j.closeReason === "removed" ? "removed" : "closed";
};

export const STATE_WORD: Record<JobState, string> = {
  draft: "Draft", in_review: "In review", live: "Live", under_review: "Under review", hidden: "Hidden", expired: "Expired", closed: "Closed", removed: "Removed",
};

/** The jobs list tabs (DD9: In review and Closed have their own). */
export const TABS = [
  ["all", "All", null], ["live", "Live", ["live"]], ["in_review", "In review", ["in_review"]], ["under_review", "Under review", ["under_review"]],
  ["expired", "Expired", ["expired"]], ["closed", "Closed", ["closed"]], ["removed", "Removed", ["hidden", "removed"]], ["draft", "Drafts", ["draft"]],
] as const satisfies readonly (readonly [string, string, readonly JobState[] | null])[];
export type TabKey = (typeof TABS)[number][0];
export const tabKey = (v: unknown): TabKey => (TABS.find((t) => t[0] === v)?.[0] ?? "all");
export const inTab = (key: TabKey, j: Job) => { const s = TABS.find((t) => t[0] === key)![2] as readonly JobState[] | null; return !s || s.includes(jobState(j)); };

/** The rules code that held a job, in words (the codes of POST /api/portal/jobs and /renew). */
export const REVIEW_WORD: Record<string, string> = {
  GENERAL_RULES_NOT_SET: "The rules for General permit jobs are not set yet, so we cannot check it.",
  OCCUPATION_INELIGIBLE: "The role is on the ineligible list, unless you meet the exception that applies to it.",
  QUOTA_FULL: "The quota for this role is full.",
  OCCUPATION_NOT_ON_LIST: "The role is not on the list of eligible occupations.",
  CONTRACT_TOO_SHORT: "The contract is shorter than the minimum.",
  RULES_FAILED: "The advert did not pass one of the checks on the text.",
  PAY_REQUIRED: "The job needs a stated salary.",
  PAY_BELOW_MINIMUM: "The salary is below the minimum for the hours.",
  PAY_NOT_ON_SCALE: "The pay is not on the scale of the grade listed.",
  STATEMENT_REQUIRED: "A General permit job needs the sponsorship statement signed.",
  NEEDS_REVIEW: "The advert needs a look from our team.",
};
export const reviewWord = (code: string | null) => (code ? REVIEW_WORD[code] ?? "It did not pass the rules in force." : null);

/** The sentence under a held, hidden or closed job (frame E08's orange card), from the list's `reason` and `reviewCode`. `when` is a date already formatted. */
export function holdWord(j: Job, when: string | null): string | null {
  const s = jobState(j);
  if (s === "in_review") return j.reason === "restricted_company" ? "Your company account is restricted, so our team checks each new job before it goes live." : "Our team is checking this job before it goes live.";
  if (s === "under_review") {
    if (j.reason === "pay_check") return "A new salary minimum took effect and this job is now below it. It is hidden from search until you edit the salary, and closes on its end date.";
    return `The renewal did not pass the rules in force. ${reviewWord(j.reviewCode) ?? ""} Edit the job to fix it; it closes on its end date.`.replace("  ", " ");
  }
  if (s === "hidden") return j.reason === "organisation_suspended" ? "Hidden while your company account is suspended." : j.reason === "report" ? "Removed from search after a report. Open Account status to see why." : "Hidden by our team. Open Account status for the reason.";
  if (s === "removed") return "Removed by our team. Open Account status to see why.";
  if (s === "expired") return `Ended${when ? ` on ${when}` : ""}.`;
  if (s === "closed") return j.closeReason === "abandoned" ? "Closed as a draft." : `Closed by you${when ? ` on ${when}` : ""}.`;
  return null;
}
/** Small notes on a job row (agency client check, the exception tick). */
export const notes = (j: Job): string[] => [j.clientCheck && "We are checking the client's name against the permit records.", j.exceptionConfirmed && "You confirmed the exception for this role."].filter((x): x is string => !!x);

const DAY = 86_400_000;
/** Whole days from `now` to `end`, rounded up (a job that ends in 20 hours has 1 day left); null with no end; negative past it. */
export const daysLeft = (end: string | null, now: number): number | null => { const t = end ? Date.parse(end) : NaN; return Number.isNaN(t) ? null : Math.ceil((t - now) / DAY); };
export const daysWord = (n: number) => (n <= 0 ? "Ends today" : n === 1 ? "1 day left" : `${n} days left`);
/** A live job counts as expiring within 3 days (the reminder's lead time). */
export const EXPIRING_DAYS = 3;

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Dublin" });
export const dateWord = (iso: string | null) => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(+d) ? DATE.format(d) : null; };
const HOUR = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: "Europe/Dublin" });
export const greeting = (now: number) => { const h = Number(HOUR.format(now)); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; };

/** The expiry cell of a job row. */
export function expiryWord(j: Job, now: number): string {
  const s = jobState(j);
  if (s === "live") { const n = daysLeft(j.closesAt, now); return n === null ? "" : daysWord(n); }
  if (s === "under_review") return j.reason === "pay_check" ? "Edit the salary" : "Edit the job";
  if (s === "in_review") return "Waiting for our team";
  if (s === "draft") return "Not posted yet";
  if (s === "hidden" || s === "removed") return "Removed from search";
  return dateWord(j.closedAt ?? j.closesAt) ?? "";
}

/** Views and apply clicks (CF70: never "Applied") summed per job over the stats read's rows. */
export type StatRow = { jobId: string; day: string; views: number; applyClicks: number };
export function totals(rows: readonly StatRow[]): Map<string, { views: number; clicks: number }> {
  const m = new Map<string, { views: number; clicks: number }>();
  for (const r of rows) { const t = m.get(r.jobId) ?? { views: 0, clicks: 0 }; t.views += r.views; t.clicks += r.applyClicks; m.set(r.jobId, t); }
  return m;
}
/** Clicks per hundred views as "2.2%"; "None yet" with no views. */
export const rateWord = (views: number, clicks: number) => (views > 0 ? `${((clicks / views) * 100).toFixed(1)}%` : "None yet");
/** A count read from a list the route caps at `cap` rows: "200+" at the cap (decision #125). */
export const countWord = (n: number, cap = 200) => (n >= cap ? `${cap}+` : String(n));

/** The team roles as the product names them (CF97). */
export const ROLE_WORD: Record<string, string> = { account_owner: "Account owner", recruiter: "Recruiter", poster: "Poster", viewer: "Viewer" };
export const roleWord = (r: string) => ROLE_WORD[r] ?? "Member";

// ===== one sentence per answer
const SERVER = "This is not working right now. Try again in a few minutes.";
const isOrigin = (a: Answer) => a.status === 403 && a.code === "BAD_ORIGIN";
/** The answers every route can give. */
export function common(a: Answer): string | null {
  if (a.status === 0) return "We could not reach the server. Check your connection and try again.";
  if (a.status === 429) return "Too many tries. Wait a few minutes, then try again.";
  if (a.status === 401) return "Your sign-in has ended. Sign in again to carry on.";
  if (isOrigin(a)) return "This page was opened from an address the employer site does not accept. Open it from the employer site address.";
  if (a.status === 413) return "That is too long. Shorten it and try again.";
  if (a.status === 403 && a.code === "NOT_A_MEMBER") return "You are no longer a member of this company.";
  if (a.status === 403 && a.code === "NOT_A_POSTER") return "Your role cannot do this. Ask the account owner.";
  if (a.status === 403 && a.code === "COMPANY_NOT_ACTIVE") return "Your company account cannot post or renew jobs now. Open Account status to see why.";
  if (a.status === 403 && a.code === "BOT_SUSPECTED") return "We could not tell you are a person. Try again, or use another browser.";
  if (a.status === 403) return "This login cannot do that. Contact support.";
  return null;
}

/** POST /api/portal/jobs/close (BA9): 200; 400; 401; 403 BAD_ORIGIN, REFUSED, NOT_A_MEMBER, NOT_A_POSTER; 404 JOB_NOT_FOUND; 409 BAD_STATE; 413; 429. */
export function closeMessage(a: Answer): string {
  if (a.status === 404) return "This job is not open any more, or it is not your company's. Reload the list.";
  if (a.status === 409) return "This job cannot be closed in its current state. Reload the list to see where it is.";
  if (a.status === 400) return "Answer whether you hired someone, then close the job.";
  return common(a) ?? SERVER;
}

/** POST /api/portal/jobs/renew (BA36): 200 live or under_review (see renewedWord); 422 OCCUPATION_INELIGIBLE asks for the exception tick; the rest as close. */
export function renewMessage(a: Answer): string {
  if (a.status === 422) return "This role has an exception or condition. Tick the box to confirm you meet it, then renew.";
  if (a.status === 404) return "This job is not live any more, or it is not your company's. Reload the list.";
  if (a.status === 400) return "That request was not right. Reload the page and try again.";
  return common(a) ?? SERVER;
}
/** The 200 answer of a renewal: what happened, in words. */
export function renewedWord(body: { status?: unknown; code?: unknown; closesAt?: unknown }): string {
  if (body.status === "under_review")
    return `The job did not pass the rules in force, so it was not renewed. It is now under review. ${typeof body.code === "string" ? reviewWord(body.code) : ""} Edit the job to fix it.`.replace(/\s+/g, " ");
  const end = typeof body.closesAt === "string" ? dateWord(body.closesAt) : null;
  return `Renewed${end ? `. It now runs until ${end}` : ""}.`;
}

/** POST /api/portal/report (BA32): 200; 400; 401; 403 BOT_SUSPECTED, BAD_ORIGIN, REFUSED; 404 JOB_NOT_FOUND, COMPANY_NOT_FOUND; 409 ALREADY_REPORTED; 413; 429. */
export function reportMessage(a: Answer): string {
  if (a.status === 404) return a.code === "COMPANY_NOT_FOUND" ? "That company has no page to report." : "That job is not live any more, so it cannot be reported.";
  if (a.status === 409) return "You already have an open report on this. We will look at it.";
  if (a.status === 400) return "Choose what is wrong and keep the details under 2000 characters.";
  if (a.status === 429) return "You have sent several reports in the last hour. Wait a while, then try again.";
  return common(a) ?? SERVER;
}
export const REPORT_REASONS = {
  job: [["asks_for_money", "It asks candidates to pay money"], ["no_sponsorship", "It says no sponsorship"], ["job_closed", "The job has closed"], ["wrong_details", "The details are wrong"], ["other", "Something else"]],
  company: [["fake_company", "The company is not real"], ["asks_for_money", "It asks candidates to pay money"], ["no_sponsorship", "It says no sponsorship"], ["other", "Something else"]],
} as const;
export const EVIDENCE_MAX = 2000;

/** POST /api/portal/agency-jobs/not-recognised (DD32): 200; 403 NOT_OWNER; 404 JOB_NOT_FOUND; the rest as close. */
export function notRecognisedMessage(a: Answer): string {
  if (a.status === 403 && a.code === "NOT_OWNER") return "Only the account owner can say a job is not yours.";
  if (a.status === 404) return "That job is not on your list any more. Reload the page.";
  return common(a) ?? SERVER;
}

/** POST /api/portal/pay-floors (DD33): sign or withdraw. REAUTH_REQUIRED is not a sentence: the page sends the person to sign in again (DD10). */
export function floorMessage(a: Answer): string {
  if (a.status === 403 && a.code === "REAUTH_REQUIRED") return "For your security, sign in again to sign a pay floor. You come back to this page.";
  if (a.status === 403 && a.code === "NOT_BIG_COMPANY") return "Pay floors are for companies on the big-company list. Yours is not on it.";
  if (a.status === 403 && a.code === "NOT_SIGNER") return "You are not a signer for this company. Ask the account owner.";
  if (a.status === 403 && a.code === "REFUSED") return "This company cannot sign a pay floor now. Open Account status to see why.";
  if (a.status === 404) return "That pay floor is not on your company's list. Reload the page.";
  if (a.status === 409) {
    if (a.code === "TEXT_CHANGED") return "The wording changed while you were reading. Reload the page, read it again and sign.";
    if (a.code === "ALREADY_PENDING") return "A floor for this role family is already waiting for its check.";
    if (a.code === "NOT_WITHDRAWABLE") return "That floor is not waiting or active, so it cannot be withdrawn.";
    return "No pay floor wording is published yet. Try again later.";
  }
  if (a.status === 400) return "Enter a four-digit role family code and a whole euro amount, and tick the box.";
  return common(a) ?? SERVER;
}
export const needsSignIn = (a: Answer) => a.status === 403 && a.code === "REAUTH_REQUIRED";
/** A sign-in address that returns to `path` (a constant path of ours). */
export const signInTo = (path: string) => `/sign-in?next=${encodeURIComponent(path)}`;

/** POST /api/portal/notices (DD34): 200; 400; 401; 403; 413; 429. */
export function noticeMessage(a: Answer): string {
  return common(a) ?? (a.status === 400 ? "That notice could not be marked. Reload the page." : SERVER);
}

/** The in-app notices (DD34), by template key. An unknown key reads as a general notice, never the raw key. */
export const NOTICE_WORD: Record<string, [string, string]> = {
  account_approved: ["Your company account is approved", "You can post jobs now."],
  account_needs_info: ["We need one more thing", "Open Verification to see what our team asked."],
  account_rejected: ["Your company account was not approved", "Contact support if you think that is a mistake."],
  account_merged: ["Your company was merged with another", "Open Company profile to see the name in use."],
  organisation_verified: ["Your company account is verified", "You can post jobs now."],
  organisation_closed: ["Your company account was closed", "Your jobs are no longer shown."],
  organisation_suspended: ["Your company account is suspended", "Open Account status to see why and what you can do."],
  job_hidden: ["One of your jobs was hidden", "Open Account status to see why."],
  job_expiry_reminder: ["A job ends in 3 days", "Renew it, or close it and tell us if you hired."],
  report_outcome: ["We reviewed your report", "Thank you for reporting. Our team looked at it and made a decision."],
  strike: ["Your company has a strike", "Open Account status to see why and how to reply."],
  strike_notice: ["Your company has a strike", "Open Account status to see why and how to reply."],
  strike_case_opened: ["We opened a case about one of your jobs", "Open Account status to reply within 7 days."],
  team_removed: ["You were removed from a company team", "You are no longer a member of it. Your own login still works."],
  owner_transferred: ["You are now the account owner", "Open Team to invite and remove members."],
  owner_reassign_done: ["Your company has a new account owner", "Open Team to see who it is. You are a recruiter now."],
  agency_client_check: ["A client name is being checked", "We are matching the client's name against the permit records."],
  rules_jobs_under_review: ["Some of your jobs went under review", "The salary minimums changed and these jobs are now below them. Open Jobs to edit the salary."],
  rules_minimums_changed: ["The salary minimums changed", "A job below the new minimum goes under review until you edit its salary."],
  pay_floor_approved: ["A pay floor was approved", "Open Pay floors to see it."],
  pay_floor_rejected: ["A pay floor was not approved", "Open Pay floors to see it."],
  pay_floor_expiring: ["A pay floor ends soon", "Open Pay floors to sign a new one."],
  pay_floor_expired: ["A pay floor has ended", "Open Pay floors to sign a new one."],
  pay_floor_lapsed: ["A pay floor has ended", "Open Pay floors to sign a new one."],
  case_update: ["A permit services case was updated", "Open Permit services to see it."],
};
export const noticeWord = (key: string): [string, string] => NOTICE_WORD[key] ?? ["You have a notice", "Open Account status to see if anything needs you."];
