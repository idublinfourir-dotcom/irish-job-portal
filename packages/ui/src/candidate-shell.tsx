import { A } from "./link";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cx, SITE_NAME } from "./cx";
import { Icon } from "./icons";

// Paths are placeholders until the page slices fix them (#288); change them here only.
const PUBLIC_NAV = [
  { label: "Find jobs", href: "/jobs" },
  { label: "Companies", href: "/companies" },
  { label: "Guides", href: "/guides" },
  { label: "Eligibility checker", href: "/eligibility-checker" },
  { label: "Permit services", href: "/permit-services" },
  { label: "For employers", href: "/employers" },
];
const SIGNED_IN_NAV = [
  { label: "Account", href: "/account" },
  { label: "Tracker", href: "/account/tracker" },
  { label: "Saved", href: "/account/saved" },
  { label: "Alerts", href: "/account/alerts" },
];
const SIGN_OUT = "/api/auth/sign-out";

const link = "inline-flex min-h-11 items-center px-2 font-semibold hover:underline underline-offset-4";

function SignOut() {
  return (
    <form method="post" action={SIGN_OUT}>
      <button type="submit" className={cx(link, "cursor-pointer")}>
        Sign out
      </button>
    </form>
  );
}

/** The public header, or the signed-in one when `signedIn`. The mobile menu is a native <details>, so it needs no script. */
export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  const items = signedIn ? SIGNED_IN_NAV : PUBLIC_NAV;
  return (
    <header className="border-b border-line bg-cream">
      <div className="mx-auto flex max-w-page items-center justify-between gap-4 px-4 py-2">
        <A href="/" className="font-heading text-xl font-semibold text-deep-green">
          {SITE_NAME}
        </A>
        <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
          {items.map((i) => (
            <A key={i.href} href={i.href} className={link}>
              {i.label}
            </A>
          ))}
          {signedIn ? (
            <SignOut />
          ) : (
            <>
              <A href="/login" className={link}>
                Log in
              </A>
              <Button href="/signup" size="sm">
                Create account
              </Button>
            </>
          )}
        </nav>
        <details className="group relative lg:hidden" data-menu>
          <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-control hover:bg-hover-light" aria-label="Menu">
            <Icon name="menu" className="group-open:hidden" />
            <Icon name="close" className="hidden group-open:block" />
          </summary>
          <nav aria-label="Mobile" className="absolute right-0 z-10 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-card border border-line bg-white p-3 shadow-pop">
            {items.map((i) => (
              <A key={i.href} href={i.href} className={link}>
                {i.label}
              </A>
            ))}
            <A href="/help" className={link}>
              Help
            </A>
            {signedIn ? (
              <SignOut />
            ) : (
              <>
                <Button href="/signup">Create free account</Button>
                <Button href="/login" variant="outline">
                  Log in
                </Button>
              </>
            )}
          </nav>
        </details>
      </div>
    </header>
  );
}

const FOOTER_GROUPS = [
  { title: "Jobs", links: [["Find jobs", "/jobs"], ["Companies", "/companies"]] },
  { title: "Help", links: [["Guides", "/guides"], ["Government updates", "/updates"], ["Eligibility checker", "/eligibility-checker"], ["Help and contact", "/help"]] },
  { title: "Services", links: [["Permit services", "/permit-services"], ["For employers", "/employers"]] },
  { title: "Legal", links: [["Terms", "/terms"], ["Privacy", "/privacy"], ["Cookies", "/cookies"]] },
] as const;

const EXT = { target: "_blank", rel: "noopener noreferrer", className: "underline underline-offset-2" } as const;

/** `standingLine` and `rulesCheckedOn` come from the page's data, never typed here. */
export function SiteFooter({ standingLine, rulesCheckedOn }: { standingLine?: ReactNode; rulesCheckedOn?: string }) {
  return (
    <footer className="mt-16 border-t border-line bg-sand">
      <div className="mx-auto grid max-w-page gap-8 px-4 py-10 sm:grid-cols-2 lg:grid-cols-4">
        {FOOTER_GROUPS.map((g) => (
          <nav key={g.title} aria-label={g.title}>
            <h2 className="mb-2 text-base">{g.title}</h2>
            <ul className="flex flex-col">
              {g.links.map(([label, href]) => (
                <li key={href}>
                  <A href={href} className="inline-flex min-h-9 items-center underline-offset-2 hover:underline">
                    {label}
                  </A>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mx-auto max-w-page space-y-2 border-t border-line px-4 py-6 text-small text-muted">
        {standingLine && <p data-slot="standing-line">{standingLine}</p>}
        {rulesCheckedOn && <p data-slot="rules-checked-on">Rules last checked on {rulesCheckedOn}</p>}
        <p>No genuine employer asks you to pay for a job offer. <A href="/report" className="underline underline-offset-2">Report it.</A></p>
        <p>
          Place names from <A href="https://www.geonames.org/" {...EXT}>GeoNames</A>, licensed <A href="https://creativecommons.org/licenses/by/4.0/" {...EXT}>CC BY 4.0</A>
        </p>
      </div>
    </footer>
  );
}

/**
 * Equal Reject and Accept (frame C02). It sets no cookie itself: the page passes the two handlers.
 * NOT mounted while decision K11 is open.
 */
export function CookieBanner({ onAccept, onReject, settingsHref = "/cookies" }: { onAccept?: () => void; onReject?: () => void; settingsHref?: string }) {
  return (
    <section aria-labelledby="cookie-title" className="fixed inset-x-0 bottom-0 z-20 border-t-2 border-ink bg-white p-4 shadow-pop">
      <div className="mx-auto flex max-w-page flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="cookie-title" className="text-lg">Cookies on {SITE_NAME}</h2>
          <p className="text-small text-muted">Essential cookies run the site. Analytics only if you accept. Nothing is set before you choose.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onReject}>Reject</Button>
          <Button variant="outline" onClick={onAccept}>Accept</Button>
          <A href={settingsHref} className="px-2 underline underline-offset-2">Cookie settings</A>
        </div>
      </div>
    </section>
  );
}

/** The candidate site frame: header, content, footer. Fixed: no data is read here. */
export function CandidateShell({ children, signedIn = false, standingLine, rulesCheckedOn }: { children: ReactNode; signedIn?: boolean; standingLine?: ReactNode; rulesCheckedOn?: string }) {
  return (
    <div className="flex min-h-screen flex-col">
      <A href="#main" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <SiteHeader signedIn={signedIn} />
      <main id="main" className="flex-1">{children}</main>
      <SiteFooter standingLine={standingLine} rulesCheckedOn={rulesCheckedOn} />
    </div>
  );
}
