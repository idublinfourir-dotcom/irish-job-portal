import { closedJobRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../../lib/candidate";

// B27: the closed-job page, for a job closed by its employer or expired: ?id. 404 for any other job. Open to visitors, rate limited.
export const GET = (r: Request) => publicRead(r, signedInCandidate, closedJobRead);
