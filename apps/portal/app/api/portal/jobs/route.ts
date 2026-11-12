import { jobList, jobPost } from "../../../../lib/jobs";

// The company's own jobs (GET) and a new job (POST, draft or live).
export const GET = (request: Request) => jobList(request);
export const POST = (request: Request) => jobPost(request);
