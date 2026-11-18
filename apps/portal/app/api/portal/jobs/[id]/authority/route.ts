import { authorityList, authorityUpload } from "../../../../../../lib/files";

// The client's written authority on an agency job: GET lists the stored copies, POST (multipart, field `file`, PDF, JPEG or PNG) uploads one.
type Ctx = { params: Promise<{ id: string }> };
export const GET = async (r: Request, { params }: Ctx) => authorityList(r, (await params).id);
export const POST = async (r: Request, { params }: Ctx) => authorityUpload(r, (await params).id);
