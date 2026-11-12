import { PortalRefused, requirePortal } from "@portal/auth";
import { handleReport } from "@portal/db";
import { portalAuth, portalOrigin } from "../../../../lib/portal";

// Report a live job: { jobId, reason, evidence? }. Any active portal login may report, with or without a company.
export const POST = (request: Request) =>
  handleReport(request, {
    origin: portalOrigin(), side: "portal",
    login: async (headers) => {
      try { return { userId: (await requirePortal(portalAuth(), headers)).userId }; } catch (e) {
        if (e instanceof PortalRefused) return { refused: e.message === "no_session" ? "no_session" : "refused" };
        throw e;
      }
    },
  });
