// The account frame (DD39, CF127): ONE nav for every account page, the card of frame NA1 (284 px at 1440, a dark pill on the current page, counts read from the
// candidate's own rows) with the page beside it. On a phone the card becomes a row of pills and the bottom bar of frame M07. A visitor gets no frame: each page sends
// them to sign-in and back (guard.ts); a suspended or deleted login is told so here. Not indexed. Reads only through lib/data.ts.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { A, Icon, Notice, SITE_NAME, type IconName } from "@portal/ui";
import { readAccountEmail, readAlerts, readCases, readProfile, readSaved, readTracker } from "../../lib/data";
import { alertsPath, applicationsPath, casesPath, profilePath, savedPath, settingsPath } from "../../lib/paths";
import { NavLink } from "./nav";

export const metadata: Metadata = { title: `Your account | ${SITE_NAME}`, robots: { index: false, follow: false } };

type Counts = { applications?: number; saved?: number; alerts?: number; cases?: number };
const LINKS: { label: string; href: string; icon: IconName; count?: keyof Counts }[] = [
  { label: "Home", href: "/account", icon: "home" },
  { label: "Applications", href: applicationsPath(), icon: "briefcase", count: "applications" },
  { label: "Saved jobs", href: savedPath(), icon: "bookmark", count: "saved" },
  { label: "Job alerts", href: alertsPath(), icon: "bell", count: "alerts" },
  { label: "Permit cases", href: casesPath(), icon: "file", count: "cases" },
  { label: "Profile and CV", href: profilePath(), icon: "user" },
  { label: "Settings", href: settingsPath(), icon: "filter" },
];
// Frame M07's bar: the site home, the job search, then the account's own pages.
const BAR: { label: string; href: string; icon: IconName }[] = [
  { label: "Home", href: "/", icon: "home" },
  { label: "Jobs", href: "/jobs", icon: "search" },
  { label: "Saved", href: savedPath(), icon: "bookmark" },
  { label: "Tracker", href: applicationsPath(), icon: "briefcase" },
  { label: "Account", href: "/account", icon: "user" },
];

const card = { base: "flex min-h-12 items-center gap-3 rounded-pill px-4 text-ui font-medium", on: "bg-ink text-white", off: "text-ink hover:bg-hover-light" };
const strip = { base: "flex min-h-11 shrink-0 items-center gap-2 rounded-pill px-4 text-small font-medium", on: "bg-ink text-white", off: "bg-sand text-ink" };
const bar = { base: "flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-caption font-medium", on: "text-deep-green", off: "text-muted" };

const countOf = (r: { ok: boolean; data?: unknown }, pick: (d: never) => number | undefined) => (r.ok ? pick(r.data as never) : undefined);

export default async function AccountLayout({ children }: { children: ReactNode }) {
  const [profile, saved, alerts, tracker, cases, login] = await Promise.all([readProfile(), readSaved(), readAlerts(), readTracker(), readCases(), readAccountEmail()]);
  if (!profile.ok) {
    if (profile.status === 401) return <>{children}</>; // signed out: the page itself sends the visitor to sign-in (guard.ts knows its address)
    return (
      <div className="mx-auto max-w-page px-5 py-16 sm:px-8">
        <h1 className="mb-4 text-[2rem]">Your account</h1>
        {profile.status === 403 ? (
          <Notice kind="error" title="This account cannot be used">It has been suspended or closed. If you think this is a mistake, <A href="/help" className="underline">use the Help page to contact us</A>.</Notice>
        ) : (
          <Notice kind="error" title="We could not load your account">Something went wrong on our side. Reload the page in a minute.</Notice>
        )}
      </div>
    );
  }
  const p = (profile.data as { profile: { fullName: string | null; locationKind: string | null } | null }).profile;
  const counts: Counts = {
    saved: countOf(saved, (d: { saved: unknown[] }) => d.saved.length),
    alerts: countOf(alerts, (d: { alerts: unknown[] }) => d.alerts.length),
    applications: countOf(tracker, (d: { count: number }) => d.count),
    cases: countOf(cases, (d: { cases: unknown[] }) => d.cases.length),
  };
  const name = p?.fullName?.trim() || login?.name.trim() || "Your account";
  const where = p?.locationKind === "ireland" ? "Living in Ireland" : p?.locationKind === "abroad" ? "Looking from abroad" : null;
  return (
    <div className="mx-auto max-w-page px-5 pb-24 pt-6 sm:px-8 lg:grid lg:grid-cols-[284px_minmax(0,1fr)] lg:gap-6 lg:pb-0">
      <aside aria-label="Your account" className="lg:sticky lg:top-4 lg:self-start">
        <div className="hidden rounded-bento bg-sand p-4 lg:block">
          <p className="flex items-center gap-3 px-2 pb-4 pt-1">
            <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-pill bg-green-tint font-heading text-[15px] font-semibold text-deep-green">{name.slice(0, 1).toUpperCase()}</span>
            <span className="min-w-0"><span className="block truncate font-semibold">{name}</span>{where && <span className="block truncate text-small text-muted">{where}</span>}</span>
          </p>
          <nav aria-label="Account" className="flex flex-col gap-1">
            {LINKS.map((l) => (
              <NavLink key={l.href} href={l.href} {...card}>
                <Icon name={l.icon} size={18} className="shrink-0" />
                <span className="flex-1">{l.label}</span>
                {l.count && counts[l.count] !== undefined && <span data-count className="rounded-pill bg-lilac px-2 text-caption font-semibold leading-6 text-ink">{counts[l.count]}</span>}
              </NavLink>
            ))}
          </nav>
        </div>
        <nav aria-label="Account sections" className="-mx-5 mb-4 flex gap-2 overflow-x-auto px-5 pb-1 sm:-mx-8 sm:px-8 lg:hidden">
          {LINKS.map((l) => (
            <NavLink key={l.href} href={l.href} {...strip}>
              {l.label}
              {l.count && counts[l.count] !== undefined && <span data-count className="rounded-pill bg-lilac px-2 text-caption font-semibold leading-6 text-ink">{counts[l.count]}</span>}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="min-w-0">{children}</div>
      <nav aria-label="Phone bar" className="fixed inset-x-0 bottom-0 z-20 flex border-t border-line bg-white lg:hidden">
        {BAR.map((l) => (
          <NavLink key={l.label} href={l.href} {...bar}>
            <Icon name={l.icon} size={22} />
            {l.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
