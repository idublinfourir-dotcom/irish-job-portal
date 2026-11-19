// Which email sender an app uses. BREVO_API_KEY and EMAIL_FROM both set: Brevo. Neither: the fake sender, which refuses
// on Vercel, in production and off localhost, so a deployed site can never quietly send nothing. Only one set: refuse to start.
import type { EmailKind, LoginPool, SendEmail } from ".";
import { createBrevoMail } from "./brevo";
import { createFakeEmail, type FakeEmail } from "./fake-email";
import { render, SITE_NAME, type Email, type Part } from "./email-layout";

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

/** The same shape as the fake sender; with Brevo the outbox stays empty (nothing is kept in memory). */
export function createMail(baseURL: string, env: NodeJS.ProcessEnv = process.env, print?: (line: string) => void, fetchImpl?: typeof fetch): FakeEmail {
  const apiKey = env.BREVO_API_KEY, from = env.EMAIL_FROM;
  if (!apiKey && !from) return createFakeEmail(baseURL, print, env);
  if (!apiKey || !from) throw new Error("BREVO_API_KEY and EMAIL_FROM must be set together (or neither, for the local fake sender).");
  const mail = createBrevoMail({ apiKey, from, fetch: fetchImpl });
  // Brevo puts its own unsubscribe on every email and a click blocks that one sender for that person (help.brevo.com 209458705), so a reset
  // comes from its own address, security@ on EMAIL_FROM's domain: an unsubscribe on a verify or invite email never blocks a later reset.
  const reset = createBrevoMail({ apiKey, from: `security@${from.split("@")[1]}`, fetch: fetchImpl });
  const send: SendEmail = async (_pool: LoginPool, kind, to, link) => {
    const m = accountEmail(kind, link, baseURL);
    await (kind === "reset" ? reset : mail)(to, m.subject, m.text, m.html);
  };
  return { outbox: [], send };
}
