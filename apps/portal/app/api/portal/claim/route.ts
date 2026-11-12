import { checkClaim, companyPost } from "../../../../lib/company";

// Claim an existing sponsor (20b path 1): { organisationId }.
export const POST = (request: Request) => companyPost(request, checkClaim, "select private.claim_organisation($1, $2) r", (user, b) => [user, b.organisationId]);
