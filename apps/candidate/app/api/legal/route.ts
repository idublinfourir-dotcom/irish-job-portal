import { legalRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// R5: the legal text in force for ?purpose=signup_terms or privacy_notice (body, version, published date). 404 NOT_FOUND before any version.
export const GET = (r: Request) => publicRead(r, signedInCandidate, legalRead);
