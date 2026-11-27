// Which email sender an app uses. BREVO_API_KEY and EMAIL_FROM both set: Brevo. Neither: the fake sender, which refuses
// on Vercel, in production and off localhost, so a deployed site can never quietly send nothing. Only one set: refuse to start.
import type { EmailKind, LoginPool, SendEmail } from ".";
import { createBrevoMail } from "./brevo";
import { createFakeEmail, type FakeEmail } from "./fake-email";
import { render, SITE_NAME, type Email, type Part } from "./email-layout";
import { ownPath } from "./reauth";

// Draft wording (E1) until the content writers' final text (N2 stays open). The link times come from the code that makes them:
// Better Auth's defaults, as createAuth sets neither (emailVerification.expiresIn and resetPasswordTokenExpiresIn, both 3600 s), and
// team_invite's `now() + interval '7 days'` (0015_ban_address.sql).
const IGNORE = "If this was not you, you can ignore this email. Nothing will change.";
const WORDS: Record<EmailKind, Omit<Part, "button" | "footer"> & { subject: string; button: string }> = {
  verify: {
    subject: "Confirm your email address", heading: "Confirm your email address", button: "Confirm email address",
    paragraphs: [`Thanks for signing up to ${SITE_NAME}. Please confirm this is your email address so you can sign in.`, "The link works for 1 hour.", IGNORE],
  },
  reset: {
    subject: "Reset your password", heading: "Reset your password", button: "Choose a new password",
    paragraphs: [`Someone asked to reset the password for your ${SITE_NAME} account. Use the button to choose a new one.`, "The link works for 1 hour and only once. Your other sign-ins will end when you change it.", IGNORE],
  },
  // C4: the old address confirms a change first, then the new address confirms itself; the change happens only on that second link.
  "change-email": {
    subject: "Confirm the change of your email address", heading: "Change your email address", button: "Confirm the change",
    paragraphs: [`Someone signed in to your ${SITE_NAME} account and asked to move it to a new email address. If it was you, use the button; we then send a link to the new address.`, "The link works for 1 hour. Nothing changes until the new address is confirmed too.", "If this was not you, ignore this email and change your password."],
  },
  "new-email": {
    subject: "Confirm your new email address", heading: "Confirm your new email address", button: "Confirm new email address",
    paragraphs: [`Please confirm this address to finish moving your ${SITE_NAME} account to it.`, "The link works for 1 hour.", IGNORE],
  },
  invite: {
    subject: `You are invited to join a company team on ${SITE_NAME}`, heading: "You are invited to join a team", button: "Accept the invitation",
    paragraphs: [`A company has invited you to join its team on ${SITE_NAME}, where it posts jobs for people who need an Irish work permit.`, "The invitation works for 7 days.", "If you did not expect this, you can ignore this email."],
  },
};
const FOOTER = `You got this email because this address was used on ${SITE_NAME}. We only send emails like this when someone asks for them.`;

/** The verify, reset or invite email. The link must be on the app's own origin (Better Auth builds it from baseURL; the invite from PORTAL_AUTH_URL). */
export function accountEmail(kind: EmailKind, link: string, baseURL: string): Email {
  if (new URL(link).origin !== new URL(baseURL).origin) throw new Error("email link refused: not on this site");
  const w = WORDS[kind];
  return render(w.subject, { heading: w.heading, paragraphs: w.paragraphs, button: { label: w.button, url: link }, footer: FOOTER });
}

/** The page an emailed confirm link opens (SEC-3): it changes nothing on GET; only its button goes on to Better Auth's GET /verify-email. */
export const CONFIRM_PATH = "/confirm-email";
const CONFIRM_KINDS: ReadonlySet<EmailKind> = new Set(["verify", "change-email", "new-email"]);
/** SEC-3: Better Auth's verify, change-email and new-email links act on a plain GET, which a mail filter's link scan triggers. On the candidate
 *  and portal pools those links are sent as our own confirm page instead, with the same token (so the same expiry and single use). callbackURL
 *  is kept only when it is a path on this site. Any other link (reset, invite, staff) is returned unchanged. */
export function confirmLink(pool: LoginPool, kind: EmailKind, link: string): string {
  const u = new URL(link);
  const token = u.searchParams.get("token");
  if (pool === "staff" || !CONFIRM_KINDS.has(kind) || !u.pathname.endsWith(`/api/auth/${pool}/verify-email`) || !token) return link;
  const q = new URLSearchParams({ token });
  const cb = u.searchParams.get("callbackURL");
  if (ownPath(cb, u.origin)) q.set("callbackURL", cb);
  return `${u.origin}${CONFIRM_PATH}?${q}`;
}

/** The same shape as the fake sender; with Brevo the outbox stays empty (nothing is kept in memory). */
export function createMail(baseURL: string, env: NodeJS.ProcessEnv = process.env, print?: (line: string) => void, fetchImpl?: typeof fetch): FakeEmail {
  const apiKey = env.BREVO_API_KEY, from = env.EMAIL_FROM;
  if (!apiKey && !from) {
    const fake = createFakeEmail(baseURL, print, env);
    return { outbox: fake.outbox, send: (pool, kind, to, link) => fake.send(pool, kind, to, confirmLink(pool, kind, link)) };
  }
  if (!apiKey || !from) throw new Error("BREVO_API_KEY and EMAIL_FROM must be set together (or neither, for the local fake sender).");
  const mail = createBrevoMail({ apiKey, from, fetch: fetchImpl });
  // Brevo puts its own unsubscribe on every email and a click blocks that one sender for that person (help.brevo.com 209458705), so a reset
  // comes from its own address, security@ on EMAIL_FROM's domain: an unsubscribe on a verify or invite email never blocks a later reset.
  // The notice to the old address about an email change is a security email too (C4).
  const reset = createBrevoMail({ apiKey, from: `security@${from.split("@")[1]}`, fetch: fetchImpl });
  const send: SendEmail = async (pool: LoginPool, kind, to, link) => {
    const m = accountEmail(kind, confirmLink(pool, kind, link), baseURL);
    await (kind === "reset" || kind === "change-email" ? reset : mail)(to, m.subject, m.text, m.html);
  };
  return { outbox: [], send };
}
