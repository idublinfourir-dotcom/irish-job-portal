import { withBotCheck } from "@portal/db";
import { portalAuth } from "../../../../../lib/portal";

// Better Auth's own routes for the portal pool: sign-up, sign-in, sign-out, get-session, email confirmation, password reset.
// Sign-up, sign-in, the reset request and the confirmation resend are bot-checked first (BOT_CHECK=on).
export const GET = (request: Request) => portalAuth().handler(request);
export const POST = (request: Request) => withBotCheck(request, GET);
