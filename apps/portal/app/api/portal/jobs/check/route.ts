import { jobCheck } from "../../../../../lib/jobs";

// The rules on a post body, as a live post would run them, with nothing written (POST).
export const POST = (request: Request) => jobCheck(request);
