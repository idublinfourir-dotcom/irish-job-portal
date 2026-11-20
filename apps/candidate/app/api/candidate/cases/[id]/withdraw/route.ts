import { caseWithdrawn } from "../../../../../../lib/cases";

// The requester withdraws an open case.
type Ctx = { params: Promise<{ id: string }> };
export const POST = async (r: Request, { params }: Ctx) => caseWithdrawn(r, (await params).id);
