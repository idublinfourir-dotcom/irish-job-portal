import { portalAuth } from "../../../../../lib/portal";

// Better Auth's own routes for the portal pool: sign-up, sign-in, sign-out, get-session, email confirmation, password reset.
export const GET = (request: Request) => portalAuth().handler(request);
export const POST = GET;
