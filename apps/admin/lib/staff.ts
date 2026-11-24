// The admin app's staff login (#169 to #172). Made on first use, not at import, so `next build` runs without the settings;
// a request with any setting missing fails closed. DATABASE_URL is the app_admin login.
import { AsyncLocalStorage } from "node:async_hooks";
import { createAuth, createMail, refuseEmail, requireStaff as check, staffSession as checkSession, staffSettings, type SendEmail } from "@portal/auth";
import { getPool } from "@portal/db";

let auth: ReturnType<typeof createAuth> | undefined;
// Better Auth catches a failed send and still answers ok, so the send's own result is kept here for the one request that asks (sendSetPassword).
const sendResult = new AsyncLocalStorage<{ sent?: boolean }>();
// Staff mail goes through Brevo only when its settings are present; otherwise it still refuses (never a silent no-op).
export const staffAuth = () => {
  if (auth) return auth;
  const settings = staffSettings(process.env), env = process.env;
  const send: SendEmail = env.BREVO_API_KEY || env.EMAIL_FROM ? createMail(settings.baseURL).send : refuseEmail;
  const sendEmail: SendEmail = async (...a) => {
    const box = sendResult.getStore();
    try {
      await send(...a);
      if (box) box.sent = true;
    } catch (e) {
      if (box) box.sent = false;
      throw e;
    }
  };
  return (auth = createAuth("staff", { database: getPool(), ...settings, sendEmail }));
};

/** Sends the set-password email (the staff reset) to a staff login's address, its link ending at our /reset-password page. True only when the sender accepted it. The staff auth has no background
 *  sender, so the send has finished when the reset call returns. */
export async function sendSetPassword(email: string): Promise<boolean> {
  const box: { sent?: boolean } = {};
  await sendResult.run(box, () => staffAuth().api.requestPasswordReset({ body: { email, redirectTo: "/reset-password" } }));
  return box.sent === true;
}

/** The signed-in, active staff member's id, or StaffRefused (from @portal/auth). `fresh` (a sensitive action, C4): a session not made by a sign-in
 *  in the last 10 minutes is StaffRefused("reauth_required"). */
export const requireStaff = (headers: Headers, fresh = false) => check(staffAuth(), headers, fresh);
/** The id and whether the session is fresh, for a route where only some actions are sensitive (refuse with StaffRefused("reauth_required")). */
export const staffSession = (headers: Headers) => checkSession(staffAuth(), headers);
