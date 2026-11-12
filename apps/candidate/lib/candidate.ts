// The candidate login (#174 to #178). Made on first use, not at import, so `next build` runs without the settings; a request with
// any setting missing fails closed. DATABASE_URL is the app_candidate login. Email goes to the fake sender, which runs on localhost only.
import { candidateSettings, createAuth, createFakeEmail, type FakeEmail } from "@portal/auth";
import { getPool } from "@portal/db";

let made: { auth: ReturnType<typeof createAuth>; mail: FakeEmail } | undefined;
function make() {
  const settings = candidateSettings(process.env);
  const mail = createFakeEmail(settings.baseURL);
  return (made ??= { auth: createAuth("candidate", { database: getPool(), ...settings, sendEmail: mail.send }), mail });
}
export const candidateAuth = () => (made ?? make()).auth;
/** The emails the fake sender kept (tests read the links here). */
export const candidateMail = () => (made ?? make()).mail.outbox;
