import { occupationRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// An occupation page with its live jobs: ?code, ?after (signed in only). A visitor gets 6 jobs.
export const GET = (r: Request) => publicRead(r, signedInCandidate, occupationRead);
