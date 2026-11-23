import { occupationsRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// Every occupation code with its title, address slug and list status, for the pickers. Open to everyone, rate limited like the other public reads.
export const GET = (r: Request) => publicRead(r, signedInCandidate, occupationsRead);
