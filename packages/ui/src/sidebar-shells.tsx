import { A } from "./link";
import { Button } from "./button";
import { cx, SITE_NAME } from "./cx";
import { Icon } from "./icons";
import { Notice } from "./display";
import type { ReactNode } from "react";
import { adminLinks, portalLinks, type AdminRole, type PortalRole } from "./nav-links";
import { NavItem } from "./nav-item";

type Link = { label: string; href: string };
type Group = { title?: string; links: Link[] };

const ITEM = { base: "flex min-h-11 shrink-0 items-center justify-between gap-3 rounded-control px-3 font-semibold", on: "bg-green-tint text-ink", off: "text-ink hover:bg-hover-light" };
// The portal sidebar is the dark one of frames NE2 and E20: the current link is the green pill.
const DARK_ITEM = { base: ITEM.base + " rounded-pill", on: "bg-deep-green text-white", off: "text-white hover:bg-ink-hover" };

/**
 * One sidebar frame for the portal and the admin. Small screens: the nav is a row you scroll sideways, so it needs no script.
 * `dark` is the portal look; `search` adds the staff search box (a plain GET form to /search, no script); `top` is the bar above the page; `footer` sits under it.
 */
function Sidebar({ brand, tag, who, groups, counts = {}, current, dark, search, top, footer, children }: { brand: ReactNode; tag?: string; who: ReactNode; groups: Group[]; counts?: Record<string, number | undefined>; current?: string; dark?: boolean; search?: boolean; top?: ReactNode; footer?: ReactNode; children: ReactNode }) {
  const item = dark ? DARK_ITEM : ITEM;
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <A href="#main" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <aside className={cx("md:w-64 md:shrink-0", dark ? "bg-ink text-white" : "border-b border-line bg-sand md:border-b-0 md:border-r")}>
        <div className="space-y-1 p-4">
          <p className={cx("font-heading text-lg font-semibold", dark ? "text-white" : "text-deep-green")}>{brand}</p>
          {tag && <p className="inline-block rounded-pill bg-ink px-2 py-0.5 text-small font-semibold text-cream">{tag}</p>}
          <div className={cx("pt-2 text-small", dark && "[&_.text-muted]:text-white/70")}>{who}</div>
          {search && (
            <form action="/search" method="get" role="search" className="pt-2">
              <label className="sr-only" htmlFor="staff-search">Search employers, jobs, cases and CRO numbers</label>
              <input id="staff-search" type="search" name="q" required maxLength={200} placeholder="Search..." className="min-h-11 w-full rounded-pill border border-line bg-white px-4 text-small text-ink placeholder:text-faint" />
              <button type="submit" className="sr-only">Search</button>
            </form>
          )}
        </div>
        <nav aria-label="Sections" className="flex gap-x-1 gap-y-3 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
          {groups.map((g, i) => (
            <div key={g.title ?? i} className="flex gap-1 md:flex-col" role={g.title ? "group" : undefined} aria-label={g.title}>
              {g.title && <p className="hidden px-3 pt-2 text-small font-semibold uppercase tracking-wide text-muted md:block">{g.title}</p>}
              {g.links.map((l) => (
                <NavItem key={l.href} href={l.href} current={current} {...item}>
                  {l.label}
                  {counts[l.label] !== undefined && (
                    <span data-count className={cx("rounded-pill px-2 text-small", dark ? "bg-ink-hover text-white" : "bg-white")}>
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
        <main id="main" className="min-w-0 flex-1 p-4 md:p-8">
          {children}
        </main>
        {footer}
      </div>
    </div>
  );
}

/** What each company status says in the portal banner (#105, #106; rows E20, DD34). Any other status shows no banner. */
const BANNER: Record<string, { kind: "error" | "warning"; title: string; text: string }> = {
  suspended: { kind: "error", title: "This company account is suspended", text: "Your jobs are hidden while we look into it. Open Account status to see why and what you can do." },
  closed: { kind: "warning", title: "This company account is closed", text: "Your jobs are no longer shown and nothing new can be posted." },
  verified_restricted: { kind: "warning", title: "This company account is restricted", text: "A new job is checked by our staff before it goes live. Open Account status for the reason." },
};

/** The bell: a count of unread notices (200 means 200 or more). A plain mark for now: the notice list page is built later, so it is not a link. */
function Bell({ unread }: { unread: number }) {
  return (
    <span role="img" aria-label={unread ? `Notices, ${unread >= 200 ? "200 or more" : unread} unread` : "Notices, none unread"} className="relative grid size-11 place-items-center rounded-pill text-ink">
      <Icon name="bell" />
      {unread > 0 && <span data-unread className="absolute -right-1 top-0 grid min-w-5 place-items-center rounded-pill bg-deep-green px-1 text-caption font-semibold text-white">{unread >= 200 ? "200+" : unread}</span>}
    </span>
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
      brand={<>{SITE_NAME} <span className="block font-sans text-small font-normal text-mint-on-dark">for employers</span></>}
      who={
        <p className="flex items-center gap-2">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-pill bg-deep-green text-small font-semibold text-white">{initials(companyName)}</span>
          <span>
            <span className="block font-semibold">{companyName}</span>
            <span className="text-muted">{role}</span>
          </span>
        </p>
      }
      groups={groups}
      counts={counts}
      current={current}
      dark
      top={
        <div className="flex items-center justify-end gap-2 border-b border-line px-4 py-3 md:px-8">
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

/** The staff sidebar (frame ND1). A link with `roles` shows only to staff holding one of them. */
export function AdminShell({ roles, name, counts, current, children }: { roles: readonly AdminRole[]; name: string; counts?: Record<string, number | undefined>; current?: string; children: ReactNode }) {
  const groups = adminLinks(roles);
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
      search
    >
      {children}
    </Sidebar>
  );
}
