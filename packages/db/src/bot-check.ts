// Bot protection with Vercel BotID, Basic mode (step 15). Both public apps run the browser part on every page (apps/*/instrumentation-client.ts),
// and a protected request without it is refused by BotID. SEC-2: on Vercel's production (VERCEL_ENV=production) the check is on unless
// BOT_CHECK is exactly "off", so a missing or mistyped variable leaves it on. Anywhere else (previews, a developer machine, tests, a local
// `next start`, where BotID has no Vercel headers and would refuse everyone) it is on only with BOT_CHECK=on exactly. Only the environment
// decides, never a request. Fail closed: with the check on, a check that throws refuses.
import { checkBotId } from "botid/server";

export const botCheckOn = (env: NodeJS.ProcessEnv) => (env.VERCEL_ENV === "production" ? env.BOT_CHECK !== "off" : env.BOT_CHECK === "on");

export async function botRefused(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (!botCheckOn(env)) return false;
  try { return (await checkBotId()).isBot; } catch { return true; }
}

/** The refusal every route sends: the code and nothing about why. */
export const botResponse = () => Response.json({ code: "BOT_SUSPECTED" }, { status: 403 });

// The Better Auth routes that are checked. The Google start (POST /sign-in/social, a fetch from the page) is checked since C5, because a "no"
// sent through it is counted; the Google callback (a redirect), sign-out, get-session and the rest are not.
export const CHECKED = ["/sign-up/email", "/sign-in/email", "/request-password-reset", "/send-verification-email", "/sign-in/social", "/change-unverified-email"];

/** Runs a Better Auth handler, after the bot check for the routes above (before Better Auth reads the body or touches the database). */
export async function withBotCheck(request: Request, handler: (r: Request) => Promise<Response>): Promise<Response> {
  let path = new URL(request.url).pathname;
  try { path = decodeURIComponent(path); } catch { path = "/sign-up/email"; } // a path that cannot be decoded is checked (fail closed)
  path = path.replace(/\/+$/, "").toLowerCase();
  if (request.method === "POST" && CHECKED.some((p) => path.endsWith(p)) && (await botRefused(process.env))) return botResponse();
  return handler(request);
}
