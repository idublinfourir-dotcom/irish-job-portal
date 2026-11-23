export const HOME_TITLE = "Jobs in Ireland with work permit sponsorship"; // 60 characters or fewer, the brand is added after it
export const HOME_DESCRIPTION =
  "Find jobs in Ireland where an employment permit is realistic. Each job shows a Critical Skills eligible or Sponsor confirmed badge. Free for candidates.";
// The employer portal is a separate app on its own address: the same PORTAL_AUTH_URL the portal uses, set on the candidate project too. Unset in
// development it is the portal's dev server; unset in production the button is hidden rather than pointing nowhere.
export const employersHref = (env: Record<string, string | undefined> = process.env): string | null =>
  env.PORTAL_AUTH_URL ? new URL("/", env.PORTAL_AUTH_URL).href : env.NODE_ENV === "production" ? null : "http://localhost:3001/";
