// The job alert routes (step 11, part 11a). Signed in: list, create, edit, pause, resume, delete (the work is in @portal/db, alerts.ts).
// Unsubscribe by token: no sign-in, no Origin check, because a mail provider's server sends the RFC 8058 one-click POST with no cookie and no Origin.
// The token is the only credential; GET shows what the page needs and changes nothing (mail scanners open links before people do).
import { candidateSettings } from "@portal/auth";
import {
  candidateRead, candidateWrite, checkAlert, checkAlertEdit, checkAlertId, createAlert, deleteAlert, editAlert, getPool, listAlerts, pauseAlert, resumeAlert,
  unsubscribe, unsubscribeInfo, unsubscribeParams,
} from "@portal/db";
import { signedInCandidate } from "./candidate";
import { OCCUPATION_CODES } from "./occupations";

const env = () => ({ origin: new URL(candidateSettings(process.env).baseURL).origin, login: signedInCandidate });

export const alertsGet = (r: Request) => candidateRead(r, env(), listAlerts);
export const alertsPost = (r: Request) => candidateWrite(r, env(), checkAlert(OCCUPATION_CODES), createAlert);
export const alertsPut = (r: Request) => candidateWrite(r, env(), checkAlertEdit(OCCUPATION_CODES), editAlert);
export const alertsDelete = (r: Request) => candidateWrite(r, env(), checkAlertId, deleteAlert);
export const alertPausePost = (r: Request) => candidateWrite(r, env(), checkAlertId, pauseAlert);
export const alertResumePost = (r: Request) => candidateWrite(r, env(), checkAlertId, resumeAlert);

const MAX_BODY = 200; // the one-click body is "List-Unsubscribe=One-Click"
const no = (status: number, code: string) => Response.json({ code }, { status });

export async function unsubscribeGet(request: Request) {
  const p = unsubscribeParams(new URL(request.url));
  return p ? Response.json(await unsubscribeInfo(getPool(), p)) : no(400, "BAD_REQUEST");
}
export async function unsubscribePost(request: Request) {
  const p = unsubscribeParams(new URL(request.url));
  if (!p) return no(400, "BAD_REQUEST");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY || (await request.text()).length > MAX_BODY) return no(413, "BODY_TOO_LARGE");
  return Response.json(await unsubscribe(getPool(), p));
}
