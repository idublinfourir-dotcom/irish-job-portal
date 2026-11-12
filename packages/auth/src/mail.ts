// Which email sender an app uses. BREVO_API_KEY and EMAIL_FROM both set: Brevo. Neither: the fake sender, which refuses
// on Vercel, in production and off localhost, so a deployed site can never quietly send nothing. Only one set: refuse to start.
import type { EmailKind, LoginPool, SendEmail } from ".";
import { createBrevoMail } from "./brevo";
import { createFakeEmail, type FakeEmail } from "./fake-email";

// PLACEHOLDER wording until the real text is written.
const WORDS: Record<EmailKind, [subject: string, line: string]> = {
  verify: ["Confirm your email address", "Open this link to confirm your email address:"],
  reset: ["Reset your password", "Open this link to choose a new password. If you did not ask for this, ignore this email:"],
  invite: ["You are invited to join a company on the portal", "Open this link to accept the invitation:"],
};
export const emailText = (kind: EmailKind, link: string): [string, string] => [WORDS[kind][0], `${WORDS[kind][1]}\n\n${link}\n`];

/** The same shape as the fake sender; with Brevo the outbox stays empty (nothing is kept in memory). */
export function createMail(baseURL: string, env: NodeJS.ProcessEnv = process.env, print?: (line: string) => void, fetchImpl?: typeof fetch): FakeEmail {
  const apiKey = env.BREVO_API_KEY, from = env.EMAIL_FROM;
  if (!apiKey && !from) return createFakeEmail(baseURL, print, env);
  if (!apiKey || !from) throw new Error("BREVO_API_KEY and EMAIL_FROM must be set together (or neither, for the local fake sender).");
  const mail = createBrevoMail({ apiKey, from, fetch: fetchImpl });
  const send: SendEmail = (_pool: LoginPool, kind, to, link) => mail(to, ...emailText(kind, link));
  return { outbox: [], send };
}
