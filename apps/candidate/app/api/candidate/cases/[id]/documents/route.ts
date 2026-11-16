import { docsList, docsUpload } from "../../../../../../lib/files";

// The documents of one's own services case: GET lists them, POST (multipart, field `file`, PDF, JPEG or PNG) uploads one.
type Ctx = { params: Promise<{ id: string }> };
export const GET = async (r: Request, { params }: Ctx) => docsList(r, (await params).id);
export const POST = async (r: Request, { params }: Ctx) => docsUpload(r, (await params).id);
