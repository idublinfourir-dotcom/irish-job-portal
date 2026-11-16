// The candidate's stored files: the CV and the documents of their own services cases. The work is in @portal/db (files.ts).
import { candidateSettings } from "@portal/auth";
import { caseDocGet, caseDocsGet, caseDocsPost, cvDelete, cvDownload, cvGet, cvPut } from "@portal/db";
import { signedInCandidate } from "./candidate";

const env = () => ({ origin: new URL(candidateSettings(process.env).baseURL).origin, login: signedInCandidate, side: "candidate" as const });

export const cvRead = (r: Request) => cvGet(r, env());
export const cvUpload = (r: Request) => cvPut(r, env());
export const cvRemove = (r: Request) => cvDelete(r, env());
export const cvLink = (r: Request) => cvDownload(r, env());
export const docsList = (r: Request, caseId: string) => caseDocsGet(r, env(), caseId);
export const docsUpload = (r: Request, caseId: string) => caseDocsPost(r, env(), caseId);
export const docLink = (r: Request, caseId: string, docId: string) => caseDocGet(r, env(), caseId, docId);
