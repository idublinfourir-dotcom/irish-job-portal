// P21: the words for every answer of the routes the company, team, account status, settings and help pages call (docs/openapi/portal.yaml). Pure, so a unit test reads the
// codes from the yaml and checks each has a sentence. `status` 0 is "no answer" (offline). No sentence names a ban, a staff member, a reporter or a library: a ban answers REFUSED (#191, #99).
export type Answer = { status: number; code?: string };

export const COUNTIES = ["Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow"] as const;
export const DESCRIPTION_MAX_FALLBACK = 2000;
export const TEXT_MAX = 1800; // a reply or an appeal (status.ts)
export const MESSAGE_MAX = 5000; // the contact form (contact route)
export const LOGO_MAX_BYTES = 1_048_576;
export const SIGNED_ROLES = ["recruiter", "poster"] as const; // who may hold the signer switch (a viewer never can)

const SERVER = "This is not working right now. Try again in a few minutes.";
const OFFLINE = "We could not reach the server. Check your connection and try again.";
const SESSION = "Your sign-in has ended. Sign in again to carry on.";
const ORIGIN = "This page was opened from an address the employer site does not accept. Open it from the employer site address.";

/** What each code of each route this slice calls says (the unit test lists the codes from docs/openapi/portal.yaml and fails on one with no sentence here). */
export const CODE_TEXT: Record<string, string> = {
  BAD_REQUEST: "Check what you typed and try again.",
  BAD_TEXT: "That text has a character we cannot take. Remove it and try again.",
  BAD_ORIGIN: ORIGIN,
  BOT_SUSPECTED: "We could not tell you are a person. Try again, or use another browser.",
  NO_SESSION: SESSION,
  REFUSED: "This login cannot do that. If you think that is a mistake, use the contact form on the Help page.",
  NOT_OWNER: "Only the account owner can do this. Ask them to open this page.",
  NOT_A_MEMBER: "This login is not in a company team now. Reload the page.",
  NO_COMPANY: "This login has no company yet.",
  ORGANISATION_NOT_AVAILABLE: "This company cannot take changes now. Open Account status to see where it stands.",
  NAME_MISMATCH: "That is not the company's exact name. Type it exactly as shown above the box.",
  FILE_TOO_LARGE: "That file is too big. Use a PNG, JPEG or WebP of 1 MB or less.",
  WRONG_FILE_TYPE: "We could not use that file. Use a PNG, JPEG or WebP picture.",
  EMPTY_FILE: "That file is empty. Choose a PNG, JPEG or WebP picture.",
  FILES_UNAVAILABLE: "Logo upload is not available right now. Try again later.",
  TOO_MANY_REQUESTS: "Too many tries. Wait 10 minutes, then try again.",
  RESEND_TOO_SOON: "That invitation was sent a moment ago. Wait 5 minutes before sending it again.",
  EMAIL_FAILED: "We could not send the email, so nothing changed. Try again in a few minutes.",
  TEAM_FULL: "The team is full. Remove a member or an open invitation to make room.",
  ALREADY_IN_TEAM: "That person is already in this team.",
  ALREADY_IN_A_COMPANY: "That login already belongs to a company.",
  OWNER_MUST_TRANSFER: "The account owner cannot leave or delete the login while others are in the team. Transfer ownership first.",
  VIEWER_NOT_SIGNER: "A viewer cannot sign the sponsorship statement. Choose another role or turn the switch off.",
  MEMBER_NOT_FOUND: "We could not find that person, invitation or request. Reload the page.",
  INVITE_NOT_VALID: "That invitation is no longer open. Reload the page.",
  NOT_ALLOWED_DOMAIN: "That email address is not on the company's domains.",
  EMAIL_NOT_VERIFIED: "Confirm the email address first. Open the link we sent when the login was made.",
  CASE_NOT_FOUND: "We could not find that case. Reload the page.",
  ALREADY_REPLIED: "You already replied to this case. A reply is sent once.",
  REPLY_CLOSED: "The time to reply to this case is over.",
  ALREADY_APPEALED: "You already appealed this decision. An appeal is sent once.",
  APPEAL_CLOSED: "The time to appeal this decision is over.",
  OPEN_SERVICES_CASE: "A permit services request of yours is still open. Close or finish it first.",
  CLOSE_COMPANY_FIRST: "You are the only member and owner of an open company. Close the company first (Company profile), then delete the login.",
  REAUTH_REQUIRED: "For your safety, sign in again to do this. We take you to the sign-in page and bring you back here.",
  DOMAIN_CHANGE_REFUSED: "The new address must be on the same email domain as the current one.",
  INVALID_EMAIL: "Enter a valid email address.",
  EMAIL_TAKEN: "That address already has a login. Use another one.",
};

/** One sentence for any answer: the code's own, else by status. */
export function say(a: Answer): string {
  if (a.status === 0) return OFFLINE;
  if (a.code && a.code in CODE_TEXT) return CODE_TEXT[a.code]!;
  if (a.code?.startsWith("INVALID_")) return ORIGIN;
  if (a.status === 429) return CODE_TEXT.TOO_MANY_REQUESTS!;
  if (a.status === 413) return "That is too long. Shorten it and try again.";
  if (a.status === 401) return SESSION;
  if (a.status === 400) return CODE_TEXT.BAD_REQUEST!;
  return SERVER;
}
export const needsReauth = (a: Answer) => a.status === 403 && a.code === "REAUTH_REQUIRED";

/** The role names the account shows (CF97: the roles that exist, not "Member"). */
export const ROLE_LABEL: Record<string, string> = { account_owner: "Account owner", recruiter: "Recruiter", poster: "Poster", viewer: "Viewer" };
export const ROLE_HELP: Record<string, string> = {
  recruiter: "Posts jobs, reviews applicants and asks for permit services.",
  poster: "Posts and edits jobs.",
  viewer: "Sees everything, changes nothing.",
};
export const INVITE_ROLES = ["viewer", "poster", "recruiter"] as const;

/** "4 Nov 2026" in Irish time for a date from a read; an unreadable value gives null. */
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Dublin" });
export const day = (iso: unknown): string | null => { const d = typeof iso === "string" ? new Date(iso) : null; return d && !Number.isNaN(+d) ? DAY.format(d) : null; };
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
