import { minimumsRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// The pay and contract minimums in force today, with no occupation. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, minimumsRead);
