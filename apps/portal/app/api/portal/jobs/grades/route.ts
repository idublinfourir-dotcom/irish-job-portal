import { jobGrades } from "../../../../../lib/jobs";

// The pay-scale grades in force, for the posting form's grade picker (#269).
export const GET = (request: Request) => jobGrades(request);
