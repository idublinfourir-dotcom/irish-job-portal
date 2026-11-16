import { withBotCheck } from "@portal/db";
import { candidateAuth } from "../../../../../lib/candidate";

// Better Auth's own routes for the candidate pool: sign-up, sign-in, sign-out, get-session, email confirmation, password reset.
// Sign-up, sign-in, the reset request and the confirmation resend are bot-checked first (BOT_CHECK=on); Google sign-in is not.
export const GET = (request: Request) => candidateAuth().handler(request);
export const POST = (request: Request) => withBotCheck(request, GET);
