import { companyRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// A company page with its live jobs: ?slug, ?after (signed in only). A visitor gets 6 jobs.
export const GET = (r: Request) => publicRead(r, signedInCandidate, companyRead);
