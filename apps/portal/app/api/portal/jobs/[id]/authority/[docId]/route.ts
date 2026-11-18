import { authorityLink } from "../../../../../../../lib/files";

// One stored written authority: a 302 to a 60-second download link, while its copy is kept.
type Ctx = { params: Promise<{ id: string; docId: string }> };
export const GET = async (r: Request, { params }: Ctx) => { const p = await params; return authorityLink(r, p.id, p.docId); };
