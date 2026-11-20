import { candidateSettings } from "@portal/auth";
import { caseTimelineGet } from "@portal/db";
import { signedInCandidate } from "../../../../../../lib/candidate";

// The timeline of one's own services case (S-Q9): every step, oldest first, with labels; never a staff id, a staff name or a note.
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
export const GET = async (r: Request, { params }: Ctx) =>
  caseTimelineGet(r, { origin: new URL(candidateSettings(process.env).baseURL).origin, login: signedInCandidate }, "candidate", (await params).id);
