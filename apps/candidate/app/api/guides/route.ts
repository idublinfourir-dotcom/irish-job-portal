import { guidesRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// B15: every published guide by title: slug, title, checkedOn. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, guidesRead);
