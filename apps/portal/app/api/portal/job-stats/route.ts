import { statsGet } from "../../../../lib/job-stats";

// Views and apply clicks by day for the company's own jobs (GET ?days=&jobId=).
export const GET = (request: Request) => statsGet(request);
