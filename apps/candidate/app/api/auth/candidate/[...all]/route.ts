import { withBotCheck } from "@portal/db";
import { candidateAuth } from "../../../../../lib/candidate";
import { withHint } from "../../../../../lib/hint";

// Better Auth's own routes for the candidate pool: sign-up, sign-in, sign-out, get-session, email confirmation, password reset.
// Sign-up, sign-in, the reset request and the confirmation resend and the Google start are bot-checked first (BOT_CHECK=on); the Google callback is not.
// Every answer carries the hint cookie when it sets or clears the session (lib/hint.ts, Stage 3 step 4).
export const GET = async (request: Request) => withHint(await candidateAuth().handler(request));
export const POST = (request: Request) => withBotCheck(request, GET);
