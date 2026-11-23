import { verificationGet } from "../../../../lib/verification";

// What the company's verification page shows: email check, CRO record, DETE match, when review opened, the newest "ask for more" question (GET).
export const GET = (request: Request) => verificationGet(request);
