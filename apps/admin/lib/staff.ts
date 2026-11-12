// The admin app's staff login (#169 to #172). Made on first use, not at import, so `next build` runs without the settings;
// a request with any setting missing fails closed. DATABASE_URL is the app_admin login.
import { createAuth, createMail, refuseEmail, requireStaff as check, staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";

let auth: ReturnType<typeof createAuth> | undefined;
// Staff mail goes through Brevo only when its settings are present; otherwise it still refuses (never a silent no-op).
export const staffAuth = () => {
  if (auth) return auth;
  const settings = staffSettings(process.env), env = process.env;
  return (auth = createAuth("staff", { database: getPool(), ...settings, sendEmail: env.BREVO_API_KEY || env.EMAIL_FROM ? createMail(settings.baseURL).send : refuseEmail }));
};

/** The signed-in, active staff member's id, or StaffRefused (from @portal/auth). */
export const requireStaff = (headers: Headers) => check(staffAuth(), headers);
