// What a staff page does with a refused read. A visitor, an ended session or a disabled login goes to the sign-in page; a login whose roles do not cover the page
// gets the "not for your roles" state (no data was read for it); anything else is a real fault and stays one. The codes are the ones the database functions and
// the session check throw (StaffRefused and QueueRefused both carry the code as the start of their message).
import { redirect } from "next/navigation";

const SIGN_IN = new Set(["no_session", "not_active", "not_active_staff"]);
/** The codes that say "your roles do not let you": a role this page needs and the login does not hold. */
const WRONG_ROLE = /^(not_reviewer|not_administrator|no_role|not_dete_link_viewer|not_content_staff)$/;

export type Guarded<T> = { refused: false; value: T } | { refused: true };

/** Runs a read as the signed-in staff member. Redirects a visitor to /sign-in (call it outside any try); `refused: true` for a wrong role. */
export async function guarded<T>(read: () => Promise<T>): Promise<Guarded<T>> {
  let code = "";
  try {
    return { refused: false, value: await read() };
  } catch (e) {
    code = e instanceof Error ? e.message.split(":")[0]! : "";
    if (!SIGN_IN.has(code) && !WRONG_ROLE.test(code)) throw e;
  }
  if (SIGN_IN.has(code)) redirect("/sign-in");
  return { refused: true };
}

/** One query value as text: the first of a repeated key is not taken, a repeated or missing one is undefined (so a hostile `?tab=a&tab=b` falls back to the default). */
export const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);
