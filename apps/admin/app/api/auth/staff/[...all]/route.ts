import { staffAuth } from "../../../../../lib/staff";

// Better Auth's own routes for the staff pool: sign-in, sign-out, get-session, password reset. Sign-up is off.
export const GET = (request: Request) => staffAuth().handler(request);
export const POST = GET;
