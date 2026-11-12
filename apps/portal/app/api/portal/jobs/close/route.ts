import { jobClose } from "../../../../../lib/jobs";

export const POST = (request: Request) => jobClose(request);
