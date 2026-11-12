// The candidate login (#174 to #178). Made on first use, not at import, so `next build` runs without the settings; a request with
// any setting missing fails closed. Google sign-in is on only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. DATABASE_URL is the app_candidate login. Email goes to the fake sender, which runs on localhost only.
import { candidateSettings, createAuth, createMail, googleSettings, type FakeEmail } from "@portal/auth";
import { getPool } from "@portal/db";

let made: { auth: ReturnType<typeof createAuth>; mail: FakeEmail } | undefined;
function make() {
  const settings = candidateSettings(process.env);
  const mail = createMail(settings.baseURL);
  return (made ??= { auth: createAuth("candidate", { database: getPool(), ...settings, sendEmail: mail.send, google: googleSettings(process.env) }), mail });
}
export const candidateAuth = () => (made ?? make()).auth;
/** The emails the fake sender kept (tests read the links here). */
export const candidateMail = () => (made ?? make()).mail.outbox;

/** The signed-in candidate for a report: a suspended or deleted candidate is refused. */
export async function candidateReporter(headers: Headers): Promise<{ userId: string } | { refused: "no_session" | "refused" }> {
  const s = await candidateAuth().api.getSession({ headers });
  if (!s) return { refused: "no_session" };
  const u = s.user as { suspendedAt?: unknown; deletedAt?: unknown };
  return u.suspendedAt || u.deletedAt ? { refused: "refused" } : { userId: s.user.id };
}
