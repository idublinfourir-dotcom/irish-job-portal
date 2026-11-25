// What the profile, CV, settings and delete pages say when a route answers (the codes are in docs/openapi/candidate.yaml; a test reads them from there).
// Pure text. A page never shows the server's own message. REAUTH_REQUIRED is not a sentence: the page asks the person to sign in again (DD10).
export const REAUTH_CODE = "REAUTH_REQUIRED";
const TROUBLE = "If you think this is a mistake, use the Help page to contact us.";

/** An answer from a route. Status 0 means no answer came (offline, blocked). */
export type Res = { ok: boolean; status: number; code?: string };

export const BY_CODE: Record<string, string> = {
  BAD_REQUEST: "Check the details and try again. Something in the form is not in the shape we expect.",
  VALIDATION_ERROR: "Check the details and try again.",
  NO_SESSION: "Your sign-in has ended. Log in again, then try again.",
  BAD_ORIGIN: "The page could not confirm where the request came from. Reload the page and try again.",
  REFUSED: `This account cannot do that. ${TROUBLE}`,
  BODY_TOO_LARGE: "That is too much text. Shorten it and try again.",
  TOO_MANY_REQUESTS: "Too many tries. Wait a few minutes, then try again.",
  BOT_SUSPECTED: "We could not check that you are a person. Reload the page and try again.",
  CV_NOT_FOUND: "There is no CV on your account.",
  TRY_AGAIN: "Two uploads crossed. Try the upload once more.",
  EMPTY_FILE: "That file is empty. Choose another one.",
  FILE_TOO_LARGE: "That file is over 4 MB. Choose a smaller one.",
  WRONG_FILE_TYPE: "Upload a PDF or a Word file (DOCX). Other types are not accepted.",
  FILE_ACTIVE_CONTENT: "That file has content we cannot accept. Save it again as a plain PDF or DOCX and upload that.",
  FILES_UNAVAILABLE: "CV uploads are not open yet. Please try again later.",
  INVALID_PASSWORD: "That is not your current password. Try again, or sign out and use Forgot password.",
  PASSWORD_TOO_SHORT: "Use at least 8 characters for the new password.",
  PASSWORD_TOO_LONG: "Use at most 128 characters for the new password.",
  INVALID_EMAIL: "Enter a valid email address, up to 254 characters.",
  EMAIL_TAKEN: "That address could not be used because it was taken before the change finished. Your address has not changed. Try another one.",
  FAILED_TO_UNLINK_LAST_ACCOUNT: "That is your only way to sign in, so it cannot be removed.",
};
const BY_STATUS = (status: number) =>
  status === 0 ? "We could not reach the site. Check your connection and try again."
  : status === 401 ? BY_CODE.NO_SESSION!
  : status === 429 ? BY_CODE.TOO_MANY_REQUESTS!
  : status >= 500 ? "Something went wrong on our side. Try again in a few minutes."
  : "That did not work. Check the details and try again.";

/** The sentence for one answer, and whether the page must ask for a fresh sign-in instead. An unknown code gets its status's general line, never the server's text. */
export function sayAccount(r: Res): { text: string; reauth: boolean } {
  if (r.code === REAUTH_CODE) return { text: "For your safety, sign in again to do this. You come back to this page.", reauth: true };
  return { text: (r.code && BY_CODE[r.code]) || BY_STATUS(r.status), reauth: false };
}

/** The `error` a link of an email change came back with (`/account/settings?error=`). */
export const emailLinkError = (code: string | undefined) => (code === "EMAIL_TAKEN" ? BY_CODE.EMAIL_TAKEN! : "That link did not work. It may have expired or been used already. Ask for a new one below.");
