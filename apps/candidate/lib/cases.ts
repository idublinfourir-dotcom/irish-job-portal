// The candidate's permit services cases (M1, M2): request, list, read and withdraw. The work is in @portal/db (services-request.ts).
import { candidateSettings } from "@portal/auth";
import { caseGet, casePost, casesGet, caseTimelineGet, caseWithdraw, type CasesEnv } from "@portal/db";
import { signedInCandidate } from "./candidate";

const env = (): CasesEnv => ({ side: "candidate", origin: new URL(candidateSettings(process.env).baseURL).origin, login: signedInCandidate });

export const caseRequest = (r: Request) => casePost(r, env());
export const caseList = (r: Request) => casesGet(r, env());
export const caseRead = (r: Request, id: string) => caseGet(r, env(), id);
export const caseWithdrawn = (r: Request, id: string) => caseWithdraw(r, env(), id);
export const caseTimeline = (r: Request, id: string) => caseTimelineGet(r, { origin: env().origin, login: signedInCandidate }, "candidate", id);
