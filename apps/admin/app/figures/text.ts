// The words of the figures page, pure so a test covers them.
import { humanKey } from "../_tools/text";

export const num = (n: number): string => n.toLocaleString("en-IE");
const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
/** "2026-11-18" as "18 Nov 2026". */
export const dayText = (d: string): string => DAY.format(new Date(`${d}T12:00:00Z`));

export const REMINDER: Record<string, string> = {
  dete_notice_check: "Check the DETE notices page",
  hand_check_100: "Hand check the accuracy sample",
  big_company_review: "Review the big-company list",
  role_review: "Review who holds which role",
  big_company_name_review: "Review a big-company name",
  registration_body_review: "Review the registration bodies",
  pay_scales_review: "Review the pay scales",
  sole_owner_retention: "A company's only owner blocks a retention erase",
  dete_page_changed: "A DETE page changed",
  dete_page_failing: "A DETE address keeps failing",
};
export const reminderText = (reason: string): string => REMINDER[reason] ?? humanKey(reason);
/** The address of a DETE page, as a link only when it is a plain web address. */
export const safeLink = (u: string | undefined): string | null => (u && /^https?:\/\/[^\s]+$/i.test(u) ? u : null);

export const TARGETS: readonly [string, string][] = [
  ["weeklyActiveCandidates", "Candidates active in the last 7 days"],
  ["yesIApplied", "\"Yes, I applied\" taps"],
  ["markApplied", "\"Mark applied\" taps"],
  ["hires", "Jobs where the employer said they hired"],
  ["hiredOnSite", "On-site applications marked hired"],
  ["liveJobs", "Live jobs now"],
  ["reports30Days", "Reports in the last 30 days"],
  ["reportsPer1000LiveJobs", "Reports per 1,000 live jobs"],
];
export const REASON_OF_LABEL: Record<string, string> = { approved: "Approved", rejected: "Rejected" };
export const queueText = (q: string): string => humanKey(q);
