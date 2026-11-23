// The documents of the signed-in portal user's own services cases (the case's portal_user_id: cases are personal, not shared with teammates).
// Any active portal login may use it, with or without a company, like the report route. The work is in @portal/db (files.ts).
import { PortalRefused, requirePortal } from "@portal/auth";
import { authorityDocGet, authorityDocsGet, authorityDocsPost, caseDocGet, caseDocsGet, caseDocsPost, logoPut, logoView, type FilesEnv } from "@portal/db";
import { portalAuth, portalOrigin } from "./portal";

const env = (): FilesEnv => ({
  origin: portalOrigin(), side: "portal",
  login: async (headers) => {
    try { return { userId: (await requirePortal(portalAuth(), headers)).userId }; } catch (e) {
      if (e instanceof PortalRefused) return { refused: e.message === "no_session" ? "no_session" : "refused" };
      throw e;
    }
  },
});

export const docsList = (r: Request, caseId: string) => caseDocsGet(r, env(), caseId);
export const docsUpload = (r: Request, caseId: string) => caseDocsPost(r, env(), caseId);
export const docLink = (r: Request, caseId: string, docId: string) => caseDocGet(r, env(), caseId, docId);
export const logoUpload = (r: Request) => logoPut(r, env());
export const logoPublic = (file: string) => logoView(file);
export const authorityList = (r: Request, jobId: string) => authorityDocsGet(r, env(), jobId);
export const authorityUpload = (r: Request, jobId: string) => authorityDocsPost(r, env(), jobId);
export const authorityLink = (r: Request, jobId: string, docId: string) => authorityDocGet(r, env(), jobId, docId);
