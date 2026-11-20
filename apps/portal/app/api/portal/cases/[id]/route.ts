import { caseRead } from "../../../../../lib/cases";

// One permit services case.
type Ctx = { params: Promise<{ id: string }> };
export const GET = async (r: Request, { params }: Ctx) => caseRead(r, (await params).id);
