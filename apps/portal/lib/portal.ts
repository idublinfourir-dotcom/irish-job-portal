// The employer and agency login (#184 to #191). Made on first use, not at import, so `next build` runs without the settings; a
// request with any setting missing fails closed. DATABASE_URL is the app_portal login. Email and password only, no Google (#190).
// Email goes to Brevo when BREVO_API_KEY and EMAIL_FROM are set, else to the fake sender, which runs on localhost only (#174).
import { createAuth, createMail, portalSettings, type FakeEmail } from "@portal/auth";
import { getPool } from "@portal/db";
import { after } from "next/server";

// Email sends run after the reply (slice 2 review finding 4). after() keeps the function alive until they end; outside a Next request
// (the tests call the route handler directly) it throws, and the send, already started, simply runs on.
const background = (task: Promise<unknown>) => { try { after(task); } catch { /* not in a Next request */ } };

let made: { auth: ReturnType<typeof createAuth>; mail: FakeEmail; origin: string } | undefined;
function make() {
  const settings = portalSettings(process.env);
  const mail = createMail(settings.baseURL);
  return (made ??= { auth: createAuth("portal", { database: getPool(), ...settings, sendEmail: mail.send, background }), mail, origin: new URL(settings.baseURL).origin });
}
export const portalAuth = () => (made ?? make()).auth;
/** The emails the fake sender kept (tests read the links here). */
export const portalMail = () => (made ?? make()).mail.outbox;
/** The portal's email sender (the fake one for now); team invites go out through it. */
export const portalSend = () => (made ?? make()).mail.send;
/** The portal's own origin (from PORTAL_AUTH_URL); the claim and register POSTs must come from it. */
export const portalOrigin = () => (made ?? make()).origin;
