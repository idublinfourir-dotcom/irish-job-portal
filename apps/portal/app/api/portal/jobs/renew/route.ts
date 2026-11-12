import { jobRenew } from "../../../../../lib/jobs";

export const POST = (request: Request) => jobRenew(request);
