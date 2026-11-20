import { PortalRefused, requirePortal } from "@portal/auth";
import { caseTimelineGet } from "@portal/db";
import { portalAuth, portalOrigin } from "../../../../../../lib/portal";

// The timeline of a services case (S-Q9): for its requester, or the Owner or a Recruiter of the company on a portal case (0061 reader rule).
// Every step, oldest first, with labels; never a staff id, a staff name or a note.
export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };
const login = async (headers: Headers) => {
  try {
    return { userId: (await requirePortal(portalAuth(), headers)).userId };
  } catch (e) {
    if (e instanceof PortalRefused) return { refused: e.message === "no_session" ? ("no_session" as const) : ("refused" as const) };
    throw e;
  }
};
export const GET = async (r: Request, { params }: Ctx) => caseTimelineGet(r, { origin: portalOrigin(), login }, "portal", (await params).id);
