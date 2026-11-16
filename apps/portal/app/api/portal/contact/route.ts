import { PortalRefused, portalSettings, requirePortal } from "@portal/auth";
import { handleContact } from "@portal/db";
import { portalAuth, portalOrigin } from "../../../../lib/portal";

// The contact form for a signed-in portal user: { topic, name?, email?, body }. Any active portal login may write, with or without a company.
export const POST = (request: Request) =>
  handleContact(request, {
    origin: portalOrigin(), side: "portal", secret: portalSettings(process.env).secret,
    login: async (headers) => {
      try { return { userId: (await requirePortal(portalAuth(), headers)).userId }; } catch (e) {
        if (e instanceof PortalRefused) return { refused: e.message === "no_session" ? "no_session" : "refused" };
        throw e;
      }
    },
  });
