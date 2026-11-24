// The words for every answer of the routes the employer sign-up, sign-in and verification pages call (docs/openapi/portal.yaml). Pure, so a unit test tries every status
// and code. `status` 0 is "no answer" (offline). No message names a ban, a staff member or a library: a ban answers REFUSED, which says nothing about why (#191).
export const MIN_PASSWORD = 8; // Better Auth's own limits, as the candidate and staff pools (#178)
export const MAX_PASSWORD = 128;
export const NAME_MAX = 100;
export const NOTE_MAX = 1000;

export type Answer = { status: number; code?: string };

const SERVER = "This is not working right now. Try again in a few minutes.";
const OFFLINE = "We could not reach the server. Check your connection and try again.";
const ORIGIN = "This page was opened from an address the employer site does not accept. Open it from the employer site address.";
const SESSION = "Your sign-in has ended. Sign in again to carry on.";
const isOrigin = ({ status, code }: Answer) => status === 403 && (code === "BAD_ORIGIN" || (!!code && code.startsWith("INVALID_")));
/** The answers every route can give, in one place. `wait` finishes the 429 sentence. */
function common(a: Answer, wait: string): string {
  if (a.status === 0) return OFFLINE;
  if (a.status === 429) return `Too many tries. ${wait}`;
  if (isOrigin(a)) return ORIGIN;
  if (a.status === 403 && a.code === "BOT_SUSPECTED") return "We could not tell you are a person. Try again, or use another browser.";
  if (a.status === 413) return "That is too long. Shorten it and try again.";
  return SERVER;
}

export const INVALID_LINK = "This link has ended or was already used. Ask for a new one.";
export const tooShort = `Use at least ${MIN_PASSWORD} characters.`;
export const tooLong = `Use at most ${MAX_PASSWORD} characters.`;
export const noMatch = "The two passwords are not the same.";

/** POST sign-up/email: 200 account made (the email must be confirmed); 400 SIGNUP_ANSWERS_REFUSED, SIGNUP_NAME_REFUSED, INVALID_EMAIL, PASSWORD_TOO_SHORT, PASSWORD_TOO_LONG or another body refusal; 503 SIGNUP_TERMS_MISSING; 403; 429. */
export function signUpMessage(a: Answer): string {
  if (a.status === 400) {
    if (a.code === "SIGNUP_ANSWERS_REFUSED") return "Tick the box to accept the terms.";
    if (a.code === "SIGNUP_NAME_REFUSED") return `Enter your name, up to ${NAME_MAX} characters.`;
    if (a.code === "PASSWORD_TOO_SHORT") return tooShort;
    if (a.code === "PASSWORD_TOO_LONG") return tooLong;
    return "Enter a valid email address, your name and a password.";
  }
  if (a.status === 422) return "That did not work. Check your details and try again.";
  if (a.status === 503 && a.code === "SIGNUP_TERMS_MISSING") return "Sign-up is not open yet. Try again later.";
  return common(a, "Wait a minute, then try again.");
}

/** POST sign-in/email: 200; 401 wrong email or password; 403 EMAIL_NOT_VERIFIED (a link was sent), or a blocked or deleted login, or an Origin not trusted; 400; 429 over 5 a minute. */
export function signInMessage(a: Answer): string {
  if (a.status === 401) return "That email and password do not match. Try again or reset your password.";
  if (a.status === 403 && a.code === "EMAIL_NOT_VERIFIED") return "Confirm your email address first. Open the link we sent you, or ask for a new one below.";
  if (a.status === 403 && !isOrigin(a) && a.code !== "BOT_SUSPECTED") return "This login cannot sign in. Contact support.";
  if (a.status === 400) return "Enter a valid email address and your password.";
  return common(a, "Wait a minute, then try again.");
}

/** POST request-password-reset and send-verification-email: 200 always (neither says whether the address has an account); 400 not an email address; 429 over 3 in 5 minutes (or 3 an hour per address). */
export function linkMessage(a: Answer): string {
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

/** The checks the sign-up and reset forms make before they ask: the same limits the route holds. Returns the message, or null when the passwords are fine. */
export function passwordProblem(password: string, repeat?: string): string | null {
  if (password.length < MIN_PASSWORD) return tooShort;
  if (password.length > MAX_PASSWORD) return tooLong;
  return repeat === undefined || password === repeat ? null : noMatch;
}

/**
 * POST /api/portal/claim and POST /api/portal/register (BA7, DD8). Every code has its own sentence: ALREADY_IN_A_COMPANY, ORGANISATION_NOT_AVAILABLE, CLAIM_COOL_DOWN,
 * EMAIL_NOT_VERIFIED, REFUSED, NUMBER_ALREADY_REGISTERED (the page also sends the person to the claim step), BAD_REQUEST, NO_SESSION, TOO_MANY_REQUESTS.
 */
export function companyMessage(a: Answer): string {
  switch (a.code) {
    case "ALREADY_IN_A_COMPANY": return "This login already belongs to a company. Open your account to carry on.";
    case "ORGANISATION_NOT_AVAILABLE": return "This company is no longer open to claim. Someone may have claimed it a moment ago. Search again, or register it as a first-time sponsor with its CRO number.";
    case "CLAIM_COOL_DOWN": return "Our team turned down your claim of this company less than 24 hours ago. Try again tomorrow, or contact support.";
    case "EMAIL_NOT_VERIFIED": return "Confirm your email address first. Open the link we sent you when you signed up.";
    case "NUMBER_ALREADY_REGISTERED": return "This number is already on the site. Search for the company and claim it.";
    case "REFUSED": return "We cannot take this request from this login. If you think that is a mistake, contact support.";
    case "NO_SESSION": return SESSION;
    case "BAD_REQUEST": return "Check the details and try again.";
    case "TOO_MANY_REQUESTS": return "Too many tries. Wait 10 minutes, then try again.";
  }
  if (a.status === 401) return SESSION;
  if (a.status === 400) return "Check the details and try again.";
  return common(a, "Wait 10 minutes, then try again.");
}

/** GET /api/portal/claim/search: 400 a query the route refuses; 401; 403; 429 over 60 in 10 minutes. */
export function searchMessage(a: Answer): string {
  if (a.status === 400) return "Type at least 3 characters of the company name, or its CRO number.";
  if (a.status === 401) return SESSION;
  if (a.status === 403) return "This login cannot search. Contact support.";
  return common(a, "Wait a few minutes, then search again.");
}

/** POST /api/portal/review-answer: 400 the note; 401; 403 REFUSED (not the owner, no company, blocked); 409 NOT_WAITING_FOR_ANSWER; 413; 429. */
export function answerMessage(a: Answer): string {
  if (a.status === 400) return `Write one line of up to ${NOTE_MAX} characters.`;
  if (a.status === 401) return SESSION;
  if (a.status === 403 && !isOrigin(a)) return "Only the account owner can answer. Ask them to open this page.";
  if (a.status === 409) return "We are not waiting for an answer from you now. Reload this page.";
  return common(a, "Wait 10 minutes, then try again.");
}

/** POST /api/portal/team { action: "accept" }: 404 INVITE_NOT_VALID; 403 EMAIL_NOT_VERIFIED, REFUSED; 409 ALREADY_IN_A_COMPANY, ALREADY_IN_TEAM, TEAM_FULL, ORGANISATION_NOT_AVAILABLE; 400; 401; 429. */
export function acceptMessage(a: Answer): string {
  switch (a.code) {
    case "INVITE_NOT_VALID": return "This invitation has ended, was already used, or was sent to another email address. Ask the account owner for a new one.";
    case "EMAIL_NOT_VERIFIED": return "Confirm your email address first. Open the link we sent you when you signed up.";
    case "ALREADY_IN_A_COMPANY": return "This login already belongs to a company. Open your account to carry on.";
    case "ALREADY_IN_TEAM": return "You are already in this team.";
    case "TEAM_FULL": return "This team has no room for another member. Ask the account owner.";
    case "ORGANISATION_NOT_AVAILABLE": return "This company cannot take on people now. Ask the account owner.";
    case "REFUSED": return "This login cannot accept the invitation. Contact support.";
    case "TOO_MANY_REQUESTS": return "Too many tries. Wait 10 minutes, then try again.";
  }
  if (a.status === 401) return SESSION;
  if (a.status === 404) return "This invitation has ended, was already used, or was sent to another email address. Ask the account owner for a new one.";
  if (a.status === 400) return "This invitation link is not complete. Open the link from the email again.";
  return common(a, "Wait 10 minutes, then try again.");
}
