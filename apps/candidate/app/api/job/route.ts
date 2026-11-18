import { jobRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// One live job: ?id. Open to visitors (linked from alerts and other sites), rate limited.
export const GET = (r: Request) => publicRead(r, signedInCandidate, jobRead);
