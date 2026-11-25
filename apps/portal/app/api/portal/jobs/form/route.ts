import { jobFormGet } from "../../../../../lib/job-form";

// B51: the posting form's reads: the sponsorship statement wording, the occupation picker's list and the #66 range note (graduate minimum from rules data).
export const GET = (request: Request) => jobFormGet(request);
