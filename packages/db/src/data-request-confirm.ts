// Decision #271: the owner of the account a data request names confirms it from the email link (step 15 Q2; outbox-cli.ts sends it with a one-time
// token, 0050 keeps only its sha256). No sign-in: the token is the only credential, and it works only on the site of its own kind of login.
// GET shows the purpose and changes nothing (mail scanners open links). POST (Origin checked) confirms once; for an export it answers with the
// owner's own export file (the candidate's runs candidate.ts's statement as app_candidate, a portal login's comes from the database), so staff never
// read it. Unknown, used, expired or another site's token: 404 INVALID_LINK, the same for each. Rate limit per client address, before any lookup.
import { createHash } from "node:crypto";
import { exportData, exportFilename } from "./candidate";
import { clientAddress, inTransaction, withinRate } from "./candidate-route";
import { getPool } from "./index";
import { toWire } from "./wire";

export type ConfirmSide = "candidate" | "portal";
export const DR_CONFIRM_RATE = { windowMs: 10 * 60_000, max: 30 }; // calls per client address, GET and POST together
export const DR_TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 random bytes, base64url
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
const TABLE = { candidate: "candidate_rate_limit", portal: "portal_rate_limit" } as const;
const MAX_BODY = 200; // the POST needs no body
const headers = { "cache-control": "no-store" };
const no = (status: number, code: string) => Response.json({ code }, { status, headers });

/** The token's hash, or the refusal: a malformed link before the rate limit, then the limit. */
async function start(request: Request, side: ConfirmSide): Promise<string | Response> {
  const q = new URL(request.url).searchParams, t = q.get("token");
  if (!t || !DR_TOKEN.test(t) || [...q.keys()].length !== 1) return no(400, "BAD_REQUEST");
  if (!(await withinRate(TABLE[side], `data-request:${clientAddress(request.headers)}`, DR_CONFIRM_RATE))) return no(429, "TOO_MANY_REQUESTS");
  return tokenHash(t);
}
function refused(e: unknown): Response {
  if ((e as { code?: string }).code === "P0001" && /^data request refused: /.test((e as Error).message)) return no(404, "INVALID_LINK");
  throw e;
}

export async function dataRequestGet(request: Request, side: ConfirmSide): Promise<Response> {
  const h = await start(request, side);
  if (h instanceof Response) return h;
  try {
    return Response.json((await getPool().query("select private.data_request_peek($1, $2) r", [h, side])).rows[0].r, { headers });
  } catch (e) {
    return refused(e);
  }
}

export async function dataRequestPost(request: Request, side: ConfirmSide, origin: string): Promise<Response> {
  if (request.headers.get("origin") !== origin) return no(403, "BAD_ORIGIN");
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY || (await request.text()).length > MAX_BODY) return no(413, "BODY_TOO_LARGE");
  const h = await start(request, side);
  if (h instanceof Response) return h;
  try {
    const out = await inTransaction(getPool(), async (c) => {
      const r: { purpose: string; userId: string; data: Record<string, unknown> | null } = (await c.query("select private.data_request_confirm($1, $2) r", [h, side])).rows[0].r;
      if (r.purpose !== "export") return { purpose: r.purpose, file: null };
      return { purpose: r.purpose, file: side === "candidate" ? await exportData(c, r.userId) : toWire({ exportedAt: new Date().toISOString(), ...r.data }) };
    });
    if (!out.file) return Response.json({ ok: true, purpose: out.purpose }, { headers });
    return Response.json(out.file, { headers: { ...headers, "content-disposition": `attachment; filename="${exportFilename(new Date())}"` } });
  } catch (e) {
    return refused(e);
  }
}
