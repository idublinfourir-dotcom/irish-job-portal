// The portal's permit services cases (M1, M2; S-Q1 B): an active Owner or Recruiter requests (the database statement checks the role); the
// requester and the company's Owners and Recruiters read; only the requester withdraws. The work is in @portal/db (services-request.ts).
import { PortalRefused, requirePortal } from "@portal/auth";
import { caseGet, casePost, casesGet, caseWithdraw, type CasesEnv } from "@portal/db";
import { portalAuth, portalOrigin } from "./portal";

const env = (): CasesEnv => ({
  side: "portal", origin: portalOrigin(),
  login: async (headers) => {
    try {
      const p = await requirePortal(portalAuth(), headers);
      return { userId: p.userId, organisationId: p.membership?.organisationId ?? null, role: p.membership?.role ?? null };
    } catch (e) {
      if (e instanceof PortalRefused) return { refused: e.message === "no_session" ? "no_session" : "refused" };
      throw e;
    }
  },
});

export const caseRequest = (r: Request) => casePost(r, env());
export const caseList = (r: Request) => casesGet(r, env());
export const caseRead = (r: Request, id: string) => caseGet(r, env(), id);
export const caseWithdrawn = (r: Request, id: string) => caseWithdraw(r, env(), id);
