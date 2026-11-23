import { permitNoticeRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// #291: the notice shown on the permit pages while DETE's portal is closed. 404 NOT_FOUND when staff have it off. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, permitNoticeRead);
