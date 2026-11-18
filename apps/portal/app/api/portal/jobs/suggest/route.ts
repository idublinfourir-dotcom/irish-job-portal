import { jobSuggest } from "../../../../../lib/jobs";

// Up to 3 occupation codes for a typed title: GET ?title=.
export const GET = (request: Request) => jobSuggest(request);
