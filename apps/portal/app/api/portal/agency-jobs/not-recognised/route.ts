import { notRecognised } from "../../../../../lib/agency-jobs";

// "I don't recognise this" on one agency job posted for this company: a report, and the job hidden at once.
export const POST = (request: Request) => notRecognised(request);
