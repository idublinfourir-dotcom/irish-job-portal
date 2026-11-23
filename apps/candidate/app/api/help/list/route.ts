import { helpListRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../../lib/candidate";

// B19: every published help page: slug, title, category. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, helpListRead);
