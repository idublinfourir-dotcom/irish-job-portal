import { publicRead, updatesRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// The updates feed, newest first: ?after (the `next` of the page before). Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, updatesRead);
