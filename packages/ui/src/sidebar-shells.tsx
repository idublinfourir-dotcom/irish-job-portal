import { A } from "./link";
import type { ReactNode } from "react";
import { cx, SITE_NAME } from "./cx";

type Link = { label: string; href: string };
type Group = { title?: string; links: Link[] };

const item = (current: boolean) =>
  cx("flex min-h-11 shrink-0 items-center justify-between gap-3 rounded-control px-3 font-semibold", current ? "bg-green-tint text-ink" : "text-ink hover:bg-hover-light");

/** One sidebar frame for the portal and the admin. Small screens: the nav is a row you scroll sideways, so it needs no script. */
function Sidebar({ brand, tag, who, groups, counts = {}, current, children }: { brand: ReactNode; tag?: string; who: ReactNode; groups: Group[]; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <A href="#main" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <aside className="border-b border-line bg-sand md:w-64 md:shrink-0 md:border-b-0 md:border-r">
        <div className="space-y-1 p-4">
          <p className="font-heading text-lg font-semibold text-deep-green">{brand}</p>
          {tag && <p className="inline-block rounded-pill bg-ink px-2 py-0.5 text-small font-semibold text-cream">{tag}</p>}
          <div className="pt-2 text-small">{who}</div>
        </div>
        <nav aria-label="Sections" className="flex gap-x-1 gap-y-3 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
          {groups.map((g, i) => (
            <div key={g.title ?? i} className="flex gap-1 md:flex-col" role={g.title ? "group" : undefined} aria-label={g.title}>
              {g.title && <p className="hidden px-3 pt-2 text-small font-semibold uppercase tracking-wide text-muted md:block">{g.title}</p>}
              {g.links.map((l) => (
                <A key={l.href} href={l.href} aria-current={l.href === current ? "page" : undefined} className={item(l.href === current)}>
                  {l.label}
                  {counts[l.label] !== undefined && (
                    <span data-count className="rounded-pill bg-white px-2 text-small">
                      {counts[l.label]}
                    </span>
                  )}
                </A>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main id="main" className="min-w-0 flex-1 p-4 md:p-8">
        {children}
      </main>
    </div>
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

// Applicants, Candidate search and Contact requests are Launch B: left out for now.
export const PORTAL_NAV: Group[] = [
  {
    links: [
      { label: "Dashboard", href: "/" },
      { label: "Jobs", href: "/jobs" },
      { label: "Post a job", href: "/jobs/new" },
      { label: "Permit services", href: "/permit-services" },
      { label: "Company profile", href: "/company" },
      { label: "Team", href: "/team" },
      { label: "Account status", href: "/account-status" },
      { label: "Help", href: "/help" },
    ],
  },
];

/** The employer sidebar (frames NE2, E08). Company name and role are props. */
export function PortalShell({ companyName, role, counts, current, children }: { companyName: string; role: string; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  return (
    <Sidebar
      brand={<>{SITE_NAME} <span className="font-sans text-small font-normal text-muted">for employers</span></>}
      who={
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-pill bg-deep-green text-small font-semibold text-white">{initials(companyName)}</span>
          <span>
            <span className="block font-semibold">{companyName}</span>
            <span className="text-muted">{role}</span>
          </span>
        </p>
      }
      groups={PORTAL_NAV}
      counts={counts}
      current={current}
    >
      {children}
    </Sidebar>
  );
}

export const ADMIN_ROLES = ["account_reviewer", "fetched_job_reviewer", "rules_data_editor", "trust_and_safety", "services_case_handler", "content_editor", "administrator"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

type AdminLink = Link & { roles?: AdminRole[] };
// Who sees a link. No role stands in for another (#104), so the administrator is listed only where it can open the page.
// This hides links only; every page and route still checks the role itself. Placeholder mapping: the owner reviews each cell (D104).
const ADMIN_NAV: { title: string; links: AdminLink[] }[] = [
  {
    title: "Queues",
    links: [
      { label: "Overview", href: "/" },
      { label: "Account reviews", href: "/account-reviews", roles: ["account_reviewer"] },
      { label: "Fetched jobs", href: "/fetched-jobs", roles: ["fetched_job_reviewer"] },
      { label: "Reports and strikes", href: "/reports", roles: ["trust_and_safety"] },
      { label: "Services cases", href: "/services", roles: ["services_case_handler"] },
    ],
  },
  {
    title: "Data",
    links: [
      { label: "Rules data", href: "/rules", roles: ["rules_data_editor"] },
      { label: "Big-company list", href: "/big-companies", roles: ["rules_data_editor"] },
      { label: "Name merges", href: "/name-merges", roles: ["account_reviewer", "fetched_job_reviewer"] },
      { label: "Ban list", href: "/bans", roles: ["trust_and_safety"] },
    ],
  },
  {
    title: "Tools",
    links: [
      { label: "Manual posting", href: "/manual-posting", roles: ["fetched_job_reviewer"] },
      { label: "Content editor", href: "/content", roles: ["content_editor"] },
      { label: "Audit log", href: "/audit" },
      { label: "Staff and roles", href: "/staff", roles: ["administrator"] },
    ],
  },
];

/** The staff sidebar (frame ND1). A link with `roles` shows only to staff holding one of them. */
export function AdminShell({ roles, name, counts, current, children }: { roles: readonly AdminRole[]; name: string; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  const groups = ADMIN_NAV.map((g) => ({ title: g.title, links: g.links.filter((l) => !l.roles || l.roles.some((r) => roles.includes(r))) })).filter((g) => g.links.length);
  return (
    <Sidebar
      brand={<>{SITE_NAME} admin</>}
      tag="Internal, staff only"
      who={
        <p>
          <span className="block font-semibold">{name}</span>
          <span className="text-muted">{roles.join(", ").replaceAll("_", " ")}</span>
        </p>
      }
      groups={groups}
      counts={counts}
      current={current}
    >
      {children}
    </Sidebar>
  );
}
