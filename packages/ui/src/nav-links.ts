// The sidebar links of the portal and the admin and who sees each: plain data in a .ts file (no JSX), so the shells render it and the database tests can read it.
// The icon names used here (a subset of icons.tsx; named in this file so the database tests, which have no JSX, can read it. The shells fail to compile on a wrong one).
export type NavIcon = "home" | "briefcase" | "plus" | "file" | "building" | "users" | "shield" | "help" | "layers" | "flag" | "clipboard" | "copy" | "close" | "pen" | "clock" | "lock";

type Link = { label: string; href: string; icon: NavIcon };

export const PORTAL_ROLES = ["viewer", "poster", "recruiter", "account_owner"] as const;
export type PortalRole = (typeof PORTAL_ROLES)[number];
type PortalLink = Link & { roles?: PortalRole[] };

// Applicants, Candidate search and Contact requests are Launch B: left out for now. A link with `roles` shows only to a member holding one of them
// (jobs.ts: a poster, recruiter or owner posts; cases.ts: an owner or recruiter requests permit services). Hides links only; every route checks the role.
export const PORTAL_NAV: { links: PortalLink[] }[] = [
  {
    links: [
      { label: "Dashboard", href: "/dashboard", icon: "home" },
      { label: "Jobs", href: "/jobs", icon: "briefcase" },
      { label: "Post a job", href: "/jobs/new", icon: "plus", roles: ["poster", "recruiter", "account_owner"] },
      { label: "Permit services", href: "/services", icon: "file", roles: ["recruiter", "account_owner"] },
      { label: "Company profile", href: "/company", icon: "building" },
      { label: "Team", href: "/team", icon: "users" },
      { label: "Account status", href: "/account-status", icon: "shield" },
      { label: "Help", href: "/help", icon: "help" },
    ],
  },
];

export const ADMIN_ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

type AdminLink = Link & { roles?: AdminRole[] };
// Who sees a link: the roles the route behind the page lets in (docs/openapi/admin.yaml x-roles of the page's GET; decision #287: the backend roles).
// No role stands in for another (#104), so the administrator is listed only where the route lets it in. Rules data is readable by any staff member.
// This hides links only; every page and route still checks the role itself (apps/admin/lib/sidebar.test.ts proves the refusals).
export const ADMIN_NAV: { title: string; links: AdminLink[] }[] = [
  {
    title: "Queues",
    links: [
      { label: "Overview", href: "/", icon: "home" },
      { label: "Account reviews", href: "/account-reviews", icon: "users", roles: ["account_reviewer"] },
      { label: "Fetched jobs", href: "/fetched-jobs", icon: "layers", roles: ["fetched_job_reviewer"] },
      { label: "Reports and strikes", href: "/reports", icon: "flag", roles: ["trust_and_safety"] },
      { label: "Services cases", href: "/services", icon: "file", roles: ["services_case_handler", "administrator"] },
    ],
  },
  {
    title: "Data",
    links: [
      { label: "Rules data", href: "/rules", icon: "clipboard" },
      { label: "Big-company list", href: "/rules/big-companies", icon: "building", roles: ["rules_data_editor", "administrator"] },
      { label: "Name merges", href: "/name-merges", icon: "copy", roles: ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "administrator"] },
      { label: "Ban list", href: "/ban-list", icon: "close", roles: ["trust_and_safety"] },
    ],
  },
  {
    title: "Tools",
    links: [
      { label: "Manual posting", href: "/manual-posting", icon: "plus", roles: ["account_reviewer", "trust_and_safety", "administrator"] },
      { label: "Content editor", href: "/content", icon: "pen", roles: ["content_editor", "rules_data_editor", "administrator"] },
      { label: "Audit log", href: "/audit", icon: "clock" },
      { label: "Staff and roles", href: "/staff", icon: "lock", roles: ["administrator"] },
    ],
  },
];


/** The admin groups with only the links a member holding `roles` may open (a link with no `roles` is for every staff member); empty groups are left out. */
export const adminLinks = (roles: readonly AdminRole[]) => ADMIN_NAV.map((g) => ({ title: g.title, links: g.links.filter((l) => !l.roles || l.roles.some((r) => roles.includes(r))) })).filter((g) => g.links.length);
/** The portal links a member of `role` may use (all of them when `role` is unset). */
export const portalLinks = (role?: PortalRole) => PORTAL_NAV.map((g) => ({ links: g.links.filter((l) => !l.roles || !role || l.roles.includes(role)) }));
