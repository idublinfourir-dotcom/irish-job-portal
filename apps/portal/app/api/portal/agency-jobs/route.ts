import { agencyJobs } from "../../../../lib/agency-jobs";

// Jobs posted for this company by agencies (read only).
export const GET = (request: Request) => agencyJobs(request);
