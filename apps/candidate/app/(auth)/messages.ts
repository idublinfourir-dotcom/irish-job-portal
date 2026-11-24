// What the sign-up, sign-in, verify, reset and permit request pages say when a route answers (the codes are in docs/openapi/candidate.yaml, plus the
// ones the auth library sends: its own bodies are `{ code, message }`). Pure text, so a test holds every code to a clear sentence. A page never shows
// the server's own message: it is English for developers.
export const PASSWORD_MIN = 8; // Better Auth's own limits, the same the server holds on sign-up, reset and change (#178)
export const PASSWORD_MAX = 128;
/** What the sign-up form sends for the "No" answer: only the answer. The route adds one to the day's count and keeps nothing else (a test posts exactly this). */
export const NO_ANSWER_BODY = { needsPermit: false } as const;
/** How long "Resend email" stays off after a send (a courtesy; the real limits are 3 in 5 minutes and 3 an hour per address). */
export const RESEND_WAIT_SECONDS = 45;

export type Flow = "signup" | "signin" | "resend" | "reset-request" | "reset" | "change-email" | "request" | "upload";
/** An answer from a route. Status 0 means no answer came (offline, blocked). */
export type Res = { ok: boolean; status: number; code?: string };
/** `screen` names a whole screen the page shows instead of a line of text. */
export type Say = { text: string; screen?: "check-email" };

const TROUBLE = "If you think this is a mistake, use the Help page to contact us.";
const WAIT = "Too many tries. Wait a few minutes, then try again.";

/** The message for one answer of one route. An unknown code gets the general line of its status, never a blank or the server's text. */
export function say(flow: Flow, r: Res): Say {
  const { status, code } = r;
  if (status === 0) return { text: "We could not reach the site. Check your connection and try again." };
  if (code === "BOT_SUSPECTED") return { text: "We could not check that you are a person. Reload the page and try again." };
  if (status === 429 || code === "TOO_MANY_REQUESTS") return { text: WAIT };
  const by = BY_CODE[flow][code ?? ""];
  if (by) return typeof by === "string" ? { text: by } : by;
  if (code === "INVALID_EMAIL" || code === "INVALID_EMAIL_FORMAT" || code === "VALIDATION_ERROR") return { text: "Check the details and try again. The email address needs to be a real one." };
  if (code === "PASSWORD_TOO_SHORT") return { text: `Use at least ${PASSWORD_MIN} characters for the password.` };
  if (code === "PASSWORD_TOO_LONG") return { text: `Use at most ${PASSWORD_MAX} characters for the password.` };
  if (status === 403 && code?.startsWith("INVALID_")) return { text: "This page was opened from an address the site does not accept. Open it from the main address and try again." }; // Better Auth's origin and URL codes
  if (status === 403 && flow === "signin") return { text: `This account cannot sign in. ${TROUBLE}` }; // suspended or deleted: Better Auth gives no code
  if (status === 403) return { text: "The page could not confirm where the request came from. Reload the page and try again." };
  if (status === 401) return { text: flow === "signin" ? BY_CODE.signin.INVALID_EMAIL_OR_PASSWORD as string : "Your sign-in has ended. Log in again and retry." };
  if (status >= 500) return { text: "Something went wrong on our side. Try again in a few minutes." };
  return { text: "That did not work. Check the details and try again." };
}

const TAKEN = "That email already has an account. Log in, or reset your password.";
const BY_CODE: Record<Flow, Record<string, string | Say>> = {
  signin: {
    INVALID_EMAIL_OR_PASSWORD: "That email and password do not match. Try again or reset your password.",
    EMAIL_NOT_VERIFIED: { text: "Your email is not verified yet.", screen: "check-email" },
  },
  signup: {
    SIGNUP_ANSWERS_REFUSED: "Say whether you need a permit, then tick the boxes that confirm you are 18 or over and accept the Terms.",
    SIGNUP_NAME_REFUSED: "Enter your name, up to 100 characters.",
    USER_ALREADY_EXISTS: TAKEN,
    USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: TAKEN,
    EMAIL_TAKEN: TAKEN,
    SIGNUP_TERMS_MISSING: "Sign-up is not open yet. Please try again later.",
  },
  resend: { ALREADY_VERIFIED: "This email is already verified, so you can log in.", EMAIL_ALREADY_VERIFIED: "This email is already verified, so you can log in." },
  "reset-request": {},
  reset: {
    INVALID_TOKEN: "This link has expired or was already used. Ask for a new one.",
    TOKEN_EXPIRED: "This link has expired or was already used. Ask for a new one.",
  },
  "change-email": {
    INVALID_EMAIL_OR_PASSWORD: "That password does not match this account. Use the password you chose when you signed up.",
    ALREADY_VERIFIED: "This email is already verified, so you can log in.",
  },
  request: {
    NOT_VERIFIED: { text: "Verify your email first. We sent you a link when you signed up.", screen: "check-email" },
    REFUSED: `This account cannot ask for permit help. ${TROUBLE}`,
    JOB_NOT_FOUND: "That job is no longer listed. Send the request without it, or go back to the jobs.",
    CASE_ALREADY_OPEN: "You already have an open request for this. You can follow it from your account.",
    CASE_LIMIT: "You have 5 open requests, the most we can hold at once. Wait for one to finish, or withdraw one.",
    BAD_REQUEST: "Check the details. Pay must be a number, and each field is at most 500 characters.",
    SERVICES_UNAVAILABLE: "Permit requests are not open yet. Please try again later.",
    BODY_TOO_LARGE: "That is too much text. Shorten it and try again.",
    NO_SESSION: "Your sign-in has ended. Log in again to send the request.",
    BAD_ORIGIN: "The page could not confirm where the request came from. Reload the page and try again.",
  },
  upload: {
    CASE_CLOSED: "This request has moved on to a decision, so it takes no more documents.",
    DOCUMENT_LIMIT: "This request already holds 20 documents, the most we keep.",
    FILE_TOO_LARGE: "That file is over 4 MB. Choose a smaller one.",
    WRONG_FILE_TYPE: "Upload a PDF, JPG or PNG.",
    FILE_ACTIVE_CONTENT: "That file has content we cannot accept. Upload a plain PDF, JPG or PNG.",
    EMPTY_FILE: "That file is empty. Choose another one.",
    BODY_TOO_LARGE: "That file is over 4 MB. Choose a smaller one.",
    NO_SESSION: "Your sign-in has ended. Log in again to upload.",
    FILES_UNAVAILABLE: "Uploads are not open yet. Please try again later.",
    CASE_NOT_FOUND: "We could not find that request.",
    BAD_REQUEST: "Choose one PDF, JPG or PNG file.",
    BAD_ORIGIN: "The page could not confirm where the request came from. Reload the page and try again.",
    REFUSED: `This account cannot upload documents. ${TROUBLE}`,
  },
};

/** The `error` code a verify link came back with (`/verify?error=`). A link used a second time is not an error: the person lands on the verified page. */
export function verifyError(code: string | undefined): string {
  switch (code) {
    case "TOKEN_EXPIRED": case "INVALID_TOKEN": return "This link has expired or was already used. Ask for a new one below.";
    case "EMAIL_TAKEN": return "Another account now uses that address, so it cannot be verified. Sign up again with a different email.";
    case "USER_NOT_FOUND": return "We could not find an account for this link. If you changed your address, use the link we sent to the new one. Otherwise sign up again.";
    case "INVALID_USER": return "This link belongs to a different account. Sign out, then open it again.";
    default: return "That link did not work. Ask for a new one below.";
  }
}
/** The `error` code a reset link came back with (`/reset?error=`). */
export const resetLinkError = (code: string | undefined) =>
  code === "INVALID_TOKEN" || code === "TOKEN_EXPIRED" || code === undefined ? "This link has expired or was already used. Ask for a new one." : "That link did not work. Ask for a new one.";

/** The password rule as the page checks it before it sends (the server checks again). */
export const passwordProblem = (p: string): string | undefined =>
  p.length < PASSWORD_MIN ? `Use at least ${PASSWORD_MIN} characters.` : p.length > PASSWORD_MAX ? `Use at most ${PASSWORD_MAX} characters.` : undefined;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,253}\.[^\s@]{2,63}$/;
export const emailProblem = (e: string): string | undefined => (e.length > 254 || !EMAIL.test(e) ? "Enter a valid email address." : undefined);
