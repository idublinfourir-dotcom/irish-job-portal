// The verification page's read (B47, E06): what the company waiting for review has so far. The database function (migration 0068) makes the checks and the
// session login always names the member; this file only turns its refusals into short codes, as the status page does.
import { getPool } from "@portal/db";
import { no, ok, portalLogin } from "./company";
import { statusRefusal } from "./status";

export async function verificationGet(request: Request): Promise<Response> {
  const login = await portalLogin(request);
  if (login instanceof Response) return login;
  if (!login.membership) return no(404, "NO_COMPANY");
  try {
    return ok({ verification: (await getPool().query("select private.verification_status($1) r", [login.userId])).rows[0].r });
  } catch (e) {
    const r = statusRefusal(e);
    if (r) return no(r.status, r.code);
    throw e;
  }
}
