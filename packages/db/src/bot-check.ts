// Bot protection with Vercel BotID, Basic mode (step 15). Off unless the environment says BOT_CHECK=on exactly: no page runs the
// browser part yet (apps/*/instrumentation-client.ts), and a request without it is refused by BotID in production. Only the
// environment can turn it on, never a request. Fail closed: with the setting on, a check that throws refuses.
import { checkBotId } from "botid/server";

export async function botRefused(env: NodeJS.ProcessEnv): Promise<boolean> {
  if (env.BOT_CHECK !== "on") return false;
  try { return (await checkBotId()).isBot; } catch { return true; }
}

/** The refusal every route sends: the code and nothing about why. */
export const botResponse = () => Response.json({ code: "BOT_SUSPECTED" }, { status: 403 });

// The Better Auth routes that are checked. The Google start (POST /sign-in/social, a fetch from the page) is checked since C5, because a "no"
// sent through it is counted; the Google callback (a redirect), sign-out, get-session and the rest are not.
const CHECKED = ["/sign-up/email", "/sign-in/email", "/request-password-reset", "/send-verification-email", "/sign-in/social"];

/** Runs a Better Auth handler, after the bot check for the five routes above (before Better Auth reads the body or touches the database). */
export async function withBotCheck(request: Request, handler: (r: Request) => Promise<Response>): Promise<Response> {
  let path = new URL(request.url).pathname;
  try { path = decodeURIComponent(path); } catch { path = "/sign-up/email"; } // a path that cannot be decoded is checked (fail closed)
  path = path.replace(/\/+$/, "").toLowerCase();
  if (request.method === "POST" && CHECKED.some((p) => path.endsWith(p)) && (await botRefused(process.env))) return botResponse();
  return handler(request);
}
