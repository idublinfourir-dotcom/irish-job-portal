import { jobGet } from "../../../../../lib/jobs";

// One of the company's own jobs in full, in the shape of the post body (GET), for the edit and repost forms.
type Ctx = { params: Promise<{ id: string }> };
export const GET = async (r: Request, { params }: Ctx) => jobGet(r, (await params).id);
