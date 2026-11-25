// What the account pages say when a route refuses (DD3). The codes are the ones in docs/openapi/candidate.yaml for the routes these pages call; messages.test.ts reads them
// from the yaml, so a code added there without words here fails. Pure text. A page never shows the server's own message.
import { messageFor } from "../jobs/api";

const BY_CODE: Record<string, string> = {
  NOT_TRACKED: "This job is no longer in your tracker. Reload the page.",
  ALERT_NOT_FOUND: "That alert no longer exists. Reload the page.",
  BAD_CURSOR: "That page of updates is not available any more. Go back to the newest.",
  REFUSED: "This account cannot do that. If you think this is a mistake, use the Help page to contact us.",
  BAD_ORIGIN: "Something went wrong. Reload the page and try again.",
  READ_FAILED: "We could not load this. Reload the page in a minute.",
};
/** The words for one answer code of one of the account routes. */
export const wording = (code: string) => BY_CODE[code] ?? messageFor(code);

/** A saved or tracked job that is not live (JobReason in the yaml): why, in plain words. */
export const REASON_TEXT: Record<string, string> = {
  under_review: "This job is under review",
  hidden_after_report: "This job is hidden while we look at a report",
  no_longer_available: "This job has closed",
};
export const reasonText = (reason: string | null | undefined) => REASON_TEXT[reason ?? ""] ?? "This job has closed";

/** The stage names of the tracker (#86). The words are ours; the codes are the route's. */
export const STAGE_TEXT: Record<string, string> = { applied: "Applied", viewed: "Viewed", shortlisted: "Shortlisted", interview: "Interview", offer: "Offer", hired: "Hired", rejected: "Not selected", withdrawn: "Withdrawn" };
/** The stages a candidate may move a job to by hand (a row on the employer's own site; an on-site row can only be withdrawn). */
export const MOVE_TO = ["applied", "interview", "offer", "rejected", "withdrawn"] as const;

/** What a notice says, by its template key (the key and params are the route's; wording is page copy). An unknown key gets the general line. */
export const NOTICE_TEXT: Record<string, { title: string; line: string }> = {
  deletion_on_hold: { title: "Your account deletion is on hold", line: "Your account was due to be deleted, but we must keep it for now while an open case about it is dealt with." },
  account_merged: { title: "Your accounts have been joined", line: "Two accounts with your details have been joined into one." },
  case_update: { title: "Your case has an update", line: "There is an update on your permit services case." },
  application_moved: { title: "An application has moved", line: "One of your applications has a new stage." },
  "inactive-warning": { title: "Your account has not been used for a while", line: "If you want to keep your account, please sign in. Accounts that stay unused may be deleted under our data rules." },
};
export const noticeText = (key: string) => NOTICE_TEXT[key] ?? { title: "You have an update", line: "Open your account to see what changed." };
