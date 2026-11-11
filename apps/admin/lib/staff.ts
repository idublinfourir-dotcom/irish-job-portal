// The admin app's staff login (#169 to #172). Made on first use, not at import, so `next build` runs without the settings;
// a request with any setting missing fails closed. DATABASE_URL is the app_admin login.
import { createAuth, refuseEmail, requireStaff as check, staffSettings } from "@portal/auth";
import { getPool } from "@portal/db";

let auth: ReturnType<typeof createAuth> | undefined;
export const staffAuth = () => (auth ??= createAuth("staff", { database: getPool(), ...staffSettings(process.env), sendEmail: refuseEmail }));

/** The signed-in, active staff member's id, or StaffRefused (from @portal/auth). */
export const requireStaff = (headers: Headers) => check(staffAuth(), headers);
