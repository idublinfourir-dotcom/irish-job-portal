import { jobEdit } from "../../../../../lib/jobs";

export const POST = (request: Request) => jobEdit(request);
