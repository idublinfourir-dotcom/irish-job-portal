import { checkRegister, companyPost } from "../../../../lib/company";

// Register a new employer or agency (20b paths 2 and 3): { kind, displayName, croNumber?, wrcLicenceNumber? }.
export const POST = (request: Request) =>
  companyPost(request, checkRegister, "select private.register_organisation($1, $2, $3, $4, $5) r", (user, b) => [user, b.kind, b.displayName, b.croNumber, b.wrcLicenceNumber]);
