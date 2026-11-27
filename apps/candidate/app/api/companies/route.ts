import { companiesRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// B25: the companies directory, 20 a page: ?q (a company or legal name, 100 characters at most), ?after (the cursor of the page before).
export const GET = (r: Request) => publicRead(r, signedInCandidate, companiesRead);
