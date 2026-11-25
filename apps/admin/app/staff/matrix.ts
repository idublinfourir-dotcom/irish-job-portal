// The permission matrix of frame D14, read from the sidebar's own link list (packages/ui nav-links.ts) so the two cannot drift: a link with no roles is for every staff member,
// otherwise only the roles it lists, and no role stands in for another (#104). Pure. Writes are checked again by each route and database function; this shows who sees each area.
import { ADMIN_NAV, ADMIN_ROLES, type AdminRole } from "@portal/ui";

export const ROLE_LABEL: Record<AdminRole, string> = {
  account_reviewer: "Account reviewer", fetched_job_reviewer: "Fetched-job reviewer", rules_data_editor: "Rules data editor", trust_and_safety: "Trust and safety",
  services_case_handler: "Services case handler", content_editor: "Content editor", administrator: "Administrator",
};
export const roleLabel = (r: string): string => ROLE_LABEL[r as AdminRole] ?? r.replaceAll("_", " ");
export const ROLES: readonly AdminRole[] = ADMIN_ROLES;

export type MatrixRow = { area: string; allowed: AdminRole[] };
/** One row per area of the sidebar (the overview is for everyone and left out). */
export const matrixRows = (): MatrixRow[] =>
  ADMIN_NAV.flatMap((g) => g.links).filter((l) => l.href !== "/").map((l) => ({ area: l.label, allowed: l.roles ? ADMIN_ROLES.filter((r) => l.roles!.includes(r)) : [...ADMIN_ROLES] }));
