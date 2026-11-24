// The words for every answer of the staff sign-in routes (docs/openapi/admin.yaml, /api/auth/staff/{path}): sign-in/email, request-password-reset and reset-password.
// Pure, so a unit test can try every status and code. `status` 0 is "no answer" (offline or the request failed). The staff session ends after 8 hours without use (#172).
export const SESSION_HOURS = 8;
export const MIN_PASSWORD = 8; // Better Auth's own limits, as the candidate pool (#178)
export const MAX_PASSWORD = 128;

export type Answer = { status: number; code?: string };

const SERVER = "This is not working right now. Try again in a few minutes.";
const OFFLINE = "We could not reach the server. Check your connection and try again.";
const ORIGIN = "This page was opened from an address the staff site does not accept. Open it from the staff site address.";
const isOrigin = (code?: string) => !!code && code.startsWith("INVALID_"); // Better Auth's own 403 codes for an Origin or a URL it does not trust (INVALID_ORIGIN, INVALID_CALLBACK_URL, ...)
/** Statuses every route can answer with, in one place. */
function common({ status, code }: Answer, wait: string): string {
  if (status === 0) return OFFLINE;
  if (status === 429) return `Too many tries. ${wait}`;
  if (status === 403 && isOrigin(code)) return ORIGIN;
  return SERVER;
}

/** POST sign-in/email: 200 signed in; 401 wrong email or password; 403 a disabled login (or an Origin not trusted); 400 a body Better Auth refuses; 429 over 5 a minute. */
export function signInMessage(a: Answer): string {
  if (a.status === 401) return "That email and password do not match. Try again or reset your password.";
  if (a.status === 403 && !isOrigin(a.code)) return "This login cannot sign in. Ask an administrator.";
  if (a.status === 400) return "Enter a valid email address and your password.";
  return common(a, "Wait a minute, then try again.");
}

/** POST request-password-reset: 200 always (it never says whether the address has a login); 400 not an email address; 429 over 3 in 5 minutes. */
export function forgotMessage(a: Answer): string {
  if (a.status === 400) return "Enter a valid email address.";
  return common(a, "Wait 5 minutes, then try again.");
}

/** POST reset-password: 200 changed; 400 INVALID_TOKEN (ended, used or not ours), PASSWORD_TOO_SHORT or PASSWORD_TOO_LONG; 429. */
export function resetMessage(a: Answer): string {
  if (a.status === 400) {
    if (a.code === "INVALID_TOKEN") return INVALID_LINK;
    if (a.code === "PASSWORD_TOO_SHORT") return tooShort;
    if (a.code === "PASSWORD_TOO_LONG") return tooLong;
    return "That did not work. Check the new password and try again.";
  }
  return common(a, "Wait a minute, then try again.");
}
export const INVALID_LINK = "This link has ended or was already used. Ask for a new one.";
export const tooShort = `Use at least ${MIN_PASSWORD} characters.`;
export const tooLong = `Use at most ${MAX_PASSWORD} characters.`;
export const noMatch = "The two passwords are not the same.";

/** The checks the reset form makes before it asks: the same limits the route holds. Returns the message, or null when the passwords are fine. */
export function passwordProblem(password: string, repeat: string): string | null {
  if (password.length < MIN_PASSWORD) return tooShort;
  if (password.length > MAX_PASSWORD) return tooLong;
  return password === repeat ? null : noMatch;
}
