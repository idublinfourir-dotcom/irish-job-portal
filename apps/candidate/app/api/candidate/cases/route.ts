import { caseList, caseRequest } from "../../../../lib/cases";

// Permit services cases: GET lists one's cases (?after), POST asks for help with a permit.
export const GET = (r: Request) => caseList(r);
export const POST = (r: Request) => caseRequest(r);
