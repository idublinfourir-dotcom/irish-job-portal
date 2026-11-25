// The words of the data requests page, pure so a test covers them.
export const surfaceLabel = (s: string): string => (s === "portal" ? "Employer portal" : "Candidate site");
export const kindLabel = (k: string): string => (k === "portal" ? "employer sign-in" : "candidate sign-in");

/** Where the owner's confirmation stands, from the item's own three fields. */
export function confirmText(i: { confirmPurpose: string | null; confirmSentAt: string | null; confirmedAt: string | null }, when: (t: string) => string): string {
  if (!i.confirmPurpose || !i.confirmSentAt) return "No link has been sent to the account owner yet.";
  const what = i.confirmPurpose === "erase" ? "erase" : "export";
  return i.confirmedAt ? `The account owner confirmed an ${what} on ${when(i.confirmedAt)}.` : `An ${what} link was sent on ${when(i.confirmSentAt)}. Waiting for the account owner.`;
}
/** The route refuses an erase proposal unless the request is proved: sent by that login while signed in, or its owner confirmed an erase. */
export const canProposeErase = (i: { signedIn: boolean; confirmPurpose: string | null; confirmedAt: string | null }): boolean => i.signedIn || (i.confirmPurpose === "erase" && i.confirmedAt !== null);

/** What an erase takes with it, named in the confirm box (docs/openapi/admin.yaml, POST /api/data-requests, erase_confirm). */
export const ERASE_GOES = [
  "the sign-in account and everything stored under it",
  "its stored files (CVs and uploads)",
  "every visitor message sent from this email address, which is emptied, with this request among them",
  "the open items that point to those messages, which close",
] as const;
