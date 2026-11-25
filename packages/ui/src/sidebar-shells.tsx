import { A } from "./link";
import { Button } from "./button";
import { cx, SITE_WORDMARK } from "./cx";
import { Icon } from "./icons";
import { SignOut } from "./sign-out";
import { Notice } from "./display";
import type { ReactNode } from "react";
import { adminLinks, portalLinks, type AdminRole, type NavIcon, type PortalRole } from "./nav-links";
import { NavItem } from "./nav-item";

type Link = { label: string; href: string; icon: NavIcon };
type Group = { title?: string; links: Link[] };

// The staff sidebar is frame ND1's (light, the current link a lilac pill), the portal's is NE2's and E20's (dark, the current link a green pill).
const ITEM = { base: "flex min-h-11 shrink-0 items-center gap-3 rounded-pill px-4 text-[14px] font-medium", on: "bg-lilac text-ink", off: "text-ink hover:bg-hover-light" };
const DARK_ITEM = { base: "flex min-h-12 shrink-0 items-center gap-3 rounded-pill px-4 text-ui font-medium", on: "bg-deep-green text-white", off: "text-white hover:bg-ink-hover" };

/**
 * One frame for the portal and the admin: a floating rounded sidebar, a bar above the page (`top`), the page, `footer`. Small screens: the sidebar is a block
 * on top and its links a row you scroll sideways, so it needs no script. `dark` is the portal look.
 */
function Sidebar({ brand, chip, groups, counts = {}, current, dark, top, footer, children }: { brand: ReactNode; chip?: ReactNode; groups: Group[]; counts?: Record<string, number | undefined>; current?: string; dark?: boolean; top?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const item = dark ? DARK_ITEM : ITEM;
  const all = groups.flatMap((g) => g.links.map((l) => l.href));
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <A href="#main" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <aside className={cx("relative m-3 overflow-hidden rounded-bento md:sticky md:top-3 md:h-[calc(100vh-1.5rem)] md:shrink-0 md:self-start md:overflow-y-auto", dark ? "bg-ink text-white md:w-[17.2rem]" : "bg-sand md:w-[14.8rem]")}>
        {dark && <span aria-hidden="true" data-ring className="pointer-events-none absolute -right-14 bottom-32 hidden size-44 rounded-pill border-[1.1rem] border-deep-green md:block" />}
        <div className="px-4 pb-2 pt-5">
          {brand}
          {chip}
        </div>
        <nav aria-label="Sections" className="relative flex gap-x-1 gap-y-4 overflow-x-auto px-3 pb-4 pt-1 md:flex-col md:overflow-visible">
          {groups.map((g, i) => (
            <div key={g.title ?? i} className="flex gap-1 md:flex-col" role={g.title ? "group" : undefined} aria-label={g.title}>
              {g.title && <p className="hidden px-4 pb-1 pt-2 text-small text-muted md:block">{g.title}</p>}
              {g.links.map((l) => (
                <NavItem key={l.href} href={l.href} current={current} among={all} {...item}>
                  <Icon name={l.icon} size={18} className="shrink-0" />
                  <span className="flex-1 whitespace-nowrap">{l.label}</span>
                  {counts[l.label] !== undefined && (
                    <span data-count className={cx("rounded-pill px-2 text-caption font-semibold leading-6", dark ? "bg-ink-hover text-white" : "bg-lilac text-ink")}>
                      {counts[l.label]}
                    </span>
                  )}
                </NavItem>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {top}
        <main id="main" className="min-w-0 flex-1 p-4 md:p-6 lg:p-8">
          {children}
        </main>
        {footer}
      </div>
    </div>
  );
}

/** The logo (as the candidate header draws it) with the name of the app beside or under it. */
function Brand({ note, dark }: { note: string; dark?: boolean }) {
  const [name, tld] = SITE_WORDMARK.split(/(?=\.)/);
  return (
    <p className={cx("font-heading text-xl font-semibold tracking-tight", dark ? "text-white" : "text-deep-green")}>
      {dark ? <>{name}<span className="text-mint-on-dark">{tld}</span></> : SITE_WORDMARK}
      <span className={cx("font-sans text-small font-normal tracking-normal", dark ? "block text-peach" : "ml-1 text-muted")}>{note}</span>
    </p>
  );
}

/** The company status beside the role in the portal's company chip. A status not listed shows only the role. */
const STATUS_LABEL: Record<string, string> = { verified: "Verified", verified_restricted: "Restricted", pending_review: "In review", needs_info: "Needs more info", suspended: "Suspended", closed: "Closed" };

/** What each company status says in the portal banner (#105, #106; rows E20, DD34). Any other status shows no banner. */
const BANNER: Record<string, { kind: "error" | "warning"; title: string; text: string }> = {
  suspended: { kind: "error", title: "This company account is suspended", text: "Your jobs are hidden while we look into it. Open Account status to see why and what you can do." },
  closed: { kind: "warning", title: "This company account is closed", text: "Your jobs are no longer shown and nothing new can be posted." },
  verified_restricted: { kind: "warning", title: "This company account is restricted", text: "A new job is checked by our staff before it goes live. Open Account status for the reason." },
};

/** The bell: a link to the notice list (/notices, DD34) with a count of unread notices (200 means 200 or more). */
function Bell({ unread }: { unread: number }) {
  return (
    <A href="/notices" aria-label={unread ? `Notices, ${unread >= 200 ? "200 or more" : unread} unread` : "Notices, none unread"} className="relative grid size-11 place-items-center rounded-pill text-ink hover:bg-hover-light">
      <Icon name="bell" />
      {unread > 0 && <span data-unread className="absolute -right-1 top-0 grid min-w-5 place-items-center rounded-pill bg-deep-green px-1 text-caption font-semibold text-white">{unread >= 200 ? "200+" : unread}</span>}
    </A>
  );
}

const FOOTER_LINKS = [["Help", "/help"], ["Account status", "/account-status"]] as const;

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");

/**
 * The employer frame (frames NE2, E08, E20). Company name and role are props; `roleKey` (the member's role) hides the links it cannot use, unset shows every link.
 * `status` (the company's status) adds the banner for a suspended, closed or restricted company, `unread` the bell's count, `standingLine` the footer's line.
 */
export function PortalShell({ companyName, role, roleKey, status, unread = 0, standingLine, counts, current, children }: { companyName: string; role: string; roleKey?: PortalRole; status?: string; unread?: number; standingLine?: ReactNode; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  const groups = portalLinks(roleKey);
  const banner = status ? BANNER[status] : undefined;
  return (
    <Sidebar
      brand={<Brand dark note="for employers" />}
      chip={
        <div data-company-chip className="mt-4 flex items-center gap-3 rounded-pill bg-ink-hover p-1.5 pr-4">
          <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-pill bg-white text-small font-semibold text-ink">{initials(companyName)}</span>
          <span className="min-w-0 text-small leading-snug">
            <span className="block truncate font-semibold">{companyName}</span>
            <span className="block truncate text-caption text-white/70">{role}{status && STATUS_LABEL[status] ? ` · ${STATUS_LABEL[status]}` : ""}</span>
          </span>
        </div>
      }
      groups={groups}
      counts={counts}
      current={current}
      dark
      top={
        <div className="flex items-center justify-end gap-2 px-4 pt-4 md:px-6 lg:px-8">
          <Bell unread={unread} />
          {groups[0]!.links.some((l) => l.href === "/jobs/new") && (
            <Button href="/jobs/new">
              <Icon name="plus" size={16} />
              Post a job
            </Button>
          )}
        </div>
      }
      footer={
        <footer className="border-t border-line px-4 py-6 text-small text-muted md:px-8">
          {standingLine && <p data-slot="standing-line">{standingLine}</p>}
          <nav aria-label="Help" className="flex flex-wrap gap-x-4">
            {FOOTER_LINKS.map(([label, href]) => (
              <A key={href} href={href} className="inline-flex min-h-9 items-center underline underline-offset-2">{label}</A>
            ))}
            <SignOut action="/api/auth/portal/sign-out" to="/sign-in" className="inline-flex min-h-9 items-center underline underline-offset-2 cursor-pointer" />
          </nav>
        </footer>
      }
    >
      {banner && (
        <div data-company-status={status} className="mb-6">
          <Notice kind={banner.kind} title={banner.title}>{banner.text}</Notice>
        </div>
      )}
      {children}
    </Sidebar>
  );
}

/** The roles beside the person's name: the first, and how many more (the full list is the tooltip and on the staff page). */
const rolesInShort = (roles: readonly AdminRole[]) => (roles[0] ? roles[0].replaceAll("_", " ") : "no role") + (roles.length > 1 ? ` and ${roles.length - 1} more` : "");

/** The staff frame (frame ND1): the light sidebar, and above the page the staff search (a plain GET form to /search, no script), the badge and the person. */
export function AdminShell({ roles, name, counts, current, children }: { roles: readonly AdminRole[]; name: string; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  return (
    <Sidebar
      brand={<Brand note="admin" />}
      groups={adminLinks(roles)}
      counts={counts}
      current={current}
      top={
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 md:px-6 lg:px-8">
          <form action="/search" method="get" role="search" className="flex min-w-60 flex-1 items-center gap-2 text-muted sm:max-w-md">
            <Icon name="search" size={18} />
            <label className="sr-only" htmlFor="staff-search">Search employers, jobs, cases and CRO numbers</label>
            <input id="staff-search" type="search" name="q" required maxLength={200} placeholder="Search employers, jobs, cases, CRO numbers" className="min-h-11 w-full rounded-pill bg-transparent px-1 text-small text-ink placeholder:text-faint" />
            <button type="submit" className="sr-only">Search</button>
          </form>
          <div className="flex items-center gap-3">
            <p className="shrink-0 whitespace-nowrap rounded-pill bg-ink px-3 py-1.5 text-small font-semibold text-white">Internal, staff only</p>
            <p className="flex items-center gap-2">
              <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-pill bg-deep-green text-small font-semibold text-white">{initials(name)}</span>
              <span className="text-small leading-snug">
                <span className="block font-semibold">{name}</span>
                <span className="block text-caption text-muted" title={roles.join(", ").replaceAll("_", " ")}>{rolesInShort(roles)}</span>
              </span>
            </p>
            <SignOut action="/api/auth/staff/sign-out" to="/sign-in" className="inline-flex min-h-11 items-center text-small underline underline-offset-2 cursor-pointer" />
          </div>
        </div>
      }
    >
      {children}
    </Sidebar>
  );
}
