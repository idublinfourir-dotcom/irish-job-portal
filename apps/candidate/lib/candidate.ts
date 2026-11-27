// The candidate login (#174 to #178). Made on first use, not at import, so `next build` runs without the settings; a request with
// any setting missing fails closed. Google sign-in is on only when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are both set. DATABASE_URL is the app_candidate login. Email goes to the fake sender, which runs on localhost only.
import { candidateSettings, createAuth, createMail, googleSettings, isFresh, sessionOnce, setSessionScope, type FakeEmail } from "@portal/auth";
import { getPool, type ReportLogin } from "@portal/db";
import { after } from "next/server";
import { cache } from "react";

// Email sends run after the reply (slice 2 review finding 4). after() keeps the function alive until they end; outside a Next request
// (the tests call the route handler directly) it throws, and the send, already started, simply runs on.
const background = (task: Promise<unknown>) => { try { after(task); } catch { /* not in a Next request */ } };

// PERF-6: one session read per request (React cache is scoped to one request; outside a render it keeps nothing, so each call reads).
setSessionScope(cache(() => new Map()));

let made: { auth: ReturnType<typeof createAuth>; mail: FakeEmail } | undefined;
function make() {
  const settings = candidateSettings(process.env);
  const mail = createMail(settings.baseURL);
  return (made ??= { auth: createAuth("candidate", { database: getPool(), ...settings, sendEmail: mail.send, background, google: googleSettings(process.env) }), mail });
}
export const candidateAuth = () => (made ?? make()).auth;
/** The emails the fake sender kept (tests read the links here). */
export const candidateMail = () => (made ?? make()).mail.outbox;

/** The signed-in candidate for every account route and the report: no session, or a suspended or deleted candidate, is refused.
 *  `fresh` (a sensitive action, C4) also refuses a session not made by a sign-in in the last REAUTH_SECONDS. */
export async function signedInCandidate(headers: Headers, fresh = false): Promise<ReportLogin> {
  const s = await sessionOnce(candidateAuth(), headers);
  if (!s) return { refused: "no_session" };
  const u = s.user as { suspendedAt?: unknown; deletedAt?: unknown };
  if (u.suspendedAt || u.deletedAt) return { refused: "refused" };
  return fresh && !isFresh(s.session) ? { refused: "reauth_required" } : { userId: s.user.id };
}
