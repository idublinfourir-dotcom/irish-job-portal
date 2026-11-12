import { candidateAuth } from "../../../../../lib/candidate";

// Better Auth's own routes for the candidate pool: sign-up, sign-in, sign-out, get-session, email confirmation, password reset.
export const GET = (request: Request) => candidateAuth().handler(request);
export const POST = GET;
