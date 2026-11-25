// What a staff tool page does with one read (settings, legal texts, data requests, solicitors, figures, my data). A visitor, an ended session or a disabled login goes to
// the sign-in page; a login whose roles the read's own role check refuses gets { ok: false } and the page shows nothing from it; anything else is a real fault and stays one.
// The codes are the ones the database functions throw (docs/openapi/admin.yaml, the 403 of each GET). Not _queue/guard.ts: that one knows only three role codes.
import { redirect } from "next/navigation";

const SIGN_IN = new Set(["no_session", "not_active", "not_active_staff"]);
const WRONG_ROLE = /^(no_role|not_(administrator|sample_staff|scheduled_staff|decision_staff|legal_staff|case_staff))$/;

export type Read<T> = { ok: true; value: T } | { ok: false };

/** Runs a read as the signed-in staff member. Redirects a visitor to /sign-in (call it outside any try). */
export async function tryRead<T>(read: () => Promise<T>): Promise<Read<T>> {
  let code = "";
  try {
    return { ok: true, value: await read() };
  } catch (e) {
    code = e instanceof Error ? e.message.split(":")[0]! : "";
    if (!SIGN_IN.has(code) && !WRONG_ROLE.test(code)) throw e;
  }
  if (SIGN_IN.has(code)) redirect("/sign-in");
  return { ok: false };
}
