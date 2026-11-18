import { helpRead, publicRead } from "@portal/db";
import { signedInCandidate } from "../../../lib/candidate";

// A published help page ("Not sure?"): ?slug. 404 NOT_FOUND when none of that slug is published (a draft or withdrawn page is never shown).
export const GET = (r: Request) => publicRead(r, signedInCandidate, helpRead);
