// The data layer of the portal pages (nextjs.org/docs/app/guides/data-security): a Server Component reads only through here, never through @portal/db or the
// lib files of the routes, so every page read goes through the same session check, role check and filter on the login's own company as the API does.
// Each read runs the route's own handler on a GET request that carries the page request's headers (its session cookie), and gives back the status and the
// JSON the route would send; the page decides what to show for a 401, 404 or 403. `server-only` is Next's own copy: importing this file from a Client
// Component fails the build. The wall test beside it (data.test.ts) keeps pages from reaching round it.
import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { ownPath, type PortalLogin } from "@portal/auth";
import { agencyJobs } from "./agency-jobs";
import { caseList } from "./cases";
import { dataRequestInfo } from "./data-request";
import { statsGet } from "./job-stats";
import { companySearch, portalLogin } from "./company";
import { freeEmail } from "./free-email";
import { jobFormGet } from "./job-form";
import { jobGet, jobList } from "./jobs";
import { portalLegalRead } from "./legal";
import { floorGet } from "./pay-floors";
import { noticesGet, settingsGet } from "./notices";
import { portalOrigin } from "./portal";
import { profileGet } from "./profile";
import { statusGet } from "./status";
import { teamGet } from "./team";
import { verificationGet } from "./verification";

type Query = ConstructorParameters<typeof URLSearchParams>[0];
/** What a route answered: its HTTP status and its JSON body (`{ code }` for a refusal). */
export type Read = { status: number; body: Record<string, unknown> };

const read = (handler: (request: Request) => Promise<Response>, path: string) => async (query?: Query): Promise<Read> => {
  const url = new URL(path, portalOrigin());
  url.search = new URLSearchParams(query).toString();
  const res = await handler(new Request(url, { headers: await headers() }));
  return { status: res.status, body: (await res.json()) as Read["body"] };
};

export const readCompany = read(profileGet, "/api/portal/company"); // the company profile; any active member
export const readVerification = read(verificationGet, "/api/portal/verification");
export const readClaimSearch = read(companySearch, "/api/portal/claim/search"); // ?q= a name or CRO number; any signed-in login (the claim and first-time steps)
export const readJobs = read(jobList, "/api/portal/jobs");
export const readJob = (id: string) => read((r) => jobGet(r, id), "/api/portal/jobs/one")();
export const readJobForm = read(jobFormGet, "/api/portal/jobs/form"); // B51: the statement wording, the occupation picker, the #66 range note and the graduate minimum
export const readJobStats = read(statsGet, "/api/portal/job-stats"); // ?days=&jobId=
export const readTeam = read(teamGet, "/api/portal/team");
export const readStatus = read(statusGet, "/api/portal/status");
export const readCases = read(caseList, "/api/portal/cases"); // ?after=
export const readDataRequest = (token: string) => read(dataRequestInfo, "/api/data-request")({ token }); // P17c: no sign-in; what the emailed link would do, changes nothing
export const readNotices = read(noticesGet, "/api/portal/notices"); // ?after=
export const readPayFloors = read(floorGet, "/api/portal/pay-floors"); // the company's pay floors and the wording to sign (DD33)
export const readNoticeSettings = read(settingsGet, "/api/portal/notices/settings"); // P21: my email switches
export const readAgencyJobs = read(agencyJobs, "/api/portal/agency-jobs"); // ?after=

/** The signed-in login with its company and role (the shell and every page's guard), or null when there is no usable session. */
export async function readLogin(): Promise<PortalLogin | null> {
  const login = await portalLogin(new Request(new URL("/api/portal/session", portalOrigin()), { headers: await headers() }));
  return login instanceof Response ? null : login;
}

/** Where a signed-out visitor goes (the sign-in page, P13); change the path here only. */
export const PORTAL_SIGN_IN = "/sign-in";
/** A page's guard: the signed-in login, or a redirect to the sign-in page (no session, or a blocked login). The roles of each page's own routes still apply. */
export async function requireLogin(): Promise<PortalLogin> {
  const login = await readLogin().catch(() => null);
  if (!login) redirect(PORTAL_SIGN_IN);
  return login;
}

/**
 * P3: what the sidebar shows: the signed-in member's company name (the company read) and role (the login), or null for a visitor, a login with no company
 * yet, or any failure (the frame must not be why a page fails; sign-up and sign-in pages share this layout and show the bare page). Three reads (login, company, notices), run together.
 * ponytail: a one-statement read of name and role in lib/profile.ts would halve the cost; add it if the sidebar's statements matter.
 */
export async function readShell(): Promise<{ companyName: string; role: string; status: string | null; unread: number } | null> {
  await headers(); // outside the try: while Next prerenders, this throws its own "dynamic page" signal, which must not be swallowed (a swallowed one bakes the signed-out frame into a static page)
  try {
    const [login, company, notices] = await Promise.all([readLogin(), readCompany(), readNotices()]);
    const c = company.body.company as { name?: unknown; status?: unknown } | undefined;
    const role = login?.membership?.role;
    const unread = notices.status === 200 && typeof notices.body.unread === "number" ? notices.body.unread : 0; // a failed bell read shows no count, never a failed page
    return company.status === 200 && typeof c?.name === "string" && role ? { companyName: c.name, role, status: typeof c.status === "string" ? c.status : null, unread } : null;
  } catch {
    return null;
  }
}

export const readLegal = (purpose: "portal_signup_terms" | "privacy_notice") => read(portalLegalRead, "/api/legal")({ purpose }); // the text in force; no login needed

/**
 * P13: a return address (?next=) kept only when it is a path on our own site (never an open redirect: `//host`, `/\\host`, `https:` and an encoded slash are all refused).
 * The check runs here, in the server component; the form gets the checked path.
 */
export const checkedNext = (value: unknown): string | null => (ownPath(value, portalOrigin()) ? value : null);

/** P13: where a signed-in login goes after sign-in: no company yet to the claim step, a company in review or asked for more to the verification page, any other to the dashboard (P18). */
export function homeFor(login: PortalLogin): string {
  const m = login.membership;
  if (!m) return "/sign-up/claim";
  return m.organisationStatus === "pending_review" || m.organisationStatus === "needs_info" ? "/verification" : "/dashboard";
}

/** P13: true when the email's domain is a free provider (E04's note: such accounts always go to review). */
export const isFreeEmail = freeEmail;

/** P13: a link to a page of the candidate site (For candidates, Help, the rules), or null when its address is not set (CANDIDATE_AUTH_URL; unset in development it is the dev server). */
export function candidateHref(path: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = env.CANDIDATE_AUTH_URL ? env.CANDIDATE_AUTH_URL : env.NODE_ENV === "production" ? null : "http://localhost:3000";
  return base ? new URL(path, base).href : null;
}
