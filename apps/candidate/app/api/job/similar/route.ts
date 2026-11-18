import { publicRead, similarRead } from "@portal/db";
import { signedInCandidate } from "../../../../lib/candidate";

// S9: "more jobs like this" for one live job: ?id. Up to 6 live jobs, never the job itself. Open to visitors, rate limited.
export const GET = (r: Request) => publicRead(r, signedInCandidate, similarRead);
