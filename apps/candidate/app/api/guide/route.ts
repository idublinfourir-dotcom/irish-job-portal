import { guideRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// B15: one published guide: ?slug. 404 NOT_FOUND when none of that slug is published (a draft or withdrawn guide is never shown). Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, guideRead);
