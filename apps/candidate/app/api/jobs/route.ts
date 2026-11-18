import { jobsRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// The job list and search: ?sort, ?after or ?before (signed in only), and the search filters. A visitor gets 6 jobs.
export const GET = (r: Request) => publicRead(r, signedInCandidate, jobsRead);
