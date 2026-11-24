import { A } from "./link";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cx, SITE_NAME, SITE_WORDMARK } from "./cx";
import { Icon } from "./icons";

// Paths are placeholders until the page slices fix them (#288); change them here only. The header follows frame N01: five links, then the
// employer link, Sign in and the main button; the eligibility checker sits in the footer and the mobile menu.
const PUBLIC_NAV = [
  { label: "Home", href: "/" },
  { label: "Find a job", href: "/jobs" },
  { label: "Companies", href: "/companies" },
  { label: "Guides", href: "/guides" },
  { label: "Permit services", href: "/permit-services" },
];
// The account menu (frame M08 and the signed-in header of NA1): the public links stay in the bar.
const ACCOUNT_NAV = [
  { label: "Account", href: "/account" },
  { label: "Tracker", href: "/account/tracker" },
  { label: "Saved", href: "/account/saved" },
  { label: "Alerts", href: "/account/alerts" },
];
const SIGN_OUT = "/api/auth/sign-out";

// Compact between 1024 and 1280 (a laptop at 125 percent scaling is about 1093 px wide), the frame's spacing from 1280.
const link = "inline-flex min-h-11 items-center whitespace-nowrap px-1.5 text-[14px] font-medium text-ink/80 hover:text-ink xl:px-2 xl:text-[15px]";
const menuLink = "inline-flex min-h-11 items-center px-2 font-semibold hover:underline underline-offset-4";

function SignOut({ className = link }: { className?: string }) {
  return (
    <form method="post" action={SIGN_OUT}>
      <button type="submit" className={cx(className, "cursor-pointer")}>
        Sign out
      </button>
    </form>
  );
}

/** The logo (frame NS7): the domain in Outfit semibold, mint; on a dark surface white with a light mint ".ie". Text, not the pack's SVG: same letters, no file. */
export function Wordmark({ className, dark }: { className?: string; dark?: boolean }) {
  const [name, tld] = SITE_WORDMARK.split(/(?=\.)/);
  return (
    <A href="/" aria-label={`${SITE_NAME}, home`} className={cx("font-heading text-[22px] font-semibold tracking-tight no-underline", dark ? "text-white" : "text-deep-green", className)}>
      {dark ? <>{name}<span className="text-mint-on-dark">{tld}</span></> : SITE_WORDMARK}
    </A>
  );
}

/** The public header, or the signed-in one when `signedIn`: a floating bar (frame N01). The mobile menu is a native <details>, so it needs no script. */
export function SiteHeader({ signedIn = false }: { signedIn?: boolean }) {
  const items = PUBLIC_NAV;
  return (
    <header className="relative z-10 px-5 pt-4 sm:px-8 sm:pt-5">
      <div className="mx-auto flex max-w-[75rem] items-center justify-between gap-3 rounded-card bg-linear-to-b from-white to-hover-light py-2 pl-5 pr-2 shadow-pop sm:pl-6">
        <Wordmark />
        <nav aria-label="Main" className="hidden flex-1 items-center lg:flex">
          <div className="flex flex-1 items-center justify-center gap-1">
            {items.map((i) => (
              <A key={i.href} href={i.href} className={i.href === "/" ? link.replace("inline-flex", "hidden xl:inline-flex") : link}>
                {i.label}
              </A>
            ))}
          </div>
          {signedIn ? (
            <div className="flex items-center gap-2">
              <A href="/account" aria-label="Notices" className="grid size-11 place-items-center rounded-pill bg-white text-ink hover:bg-hover-light">
                <Icon name="bell" />
              </A>
              <details className="group relative" data-account-menu>
                <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-pill bg-deep-green text-white" aria-label="Account menu">
                  <Icon name="user" />
                </summary>
                <div className="absolute right-0 z-10 mt-2 flex w-56 flex-col rounded-card border border-line bg-white p-2 shadow-pop">
                  {ACCOUNT_NAV.map((i) => (
                    <A key={i.href} href={i.href} className={menuLink}>
                      {i.label}
                    </A>
                  ))}
                  <SignOut className={menuLink} />
                </div>
              </details>
            </div>
          ) : (
            <div className="flex items-center gap-1">
              <A href="/employers" className={link}>
                For employers
              </A>
              <A href="/login" className={link}>
                Sign in
              </A>
              <Button href="/signup" size="lg" className="ml-1 xl:ml-2">
                Create free account <Icon name="arrow" size={16} />
              </Button>
            </div>
          )}
        </nav>
        <div className="flex items-center gap-2 lg:hidden">
          {!signedIn && (
            <A href="/login" className="hidden px-2 text-small font-semibold min-[360px]:inline">
              Sign in
            </A>
          )}
          <details className="group relative" data-menu>
            <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-pill bg-ink text-white" aria-label="Menu">
              <Icon name="menu" className="group-open:hidden" />
              <Icon name="close" className="hidden group-open:block" />
            </summary>
            <nav aria-label="Mobile" className="absolute right-0 z-10 mt-2 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-1 rounded-card border border-line bg-white p-3 shadow-pop">
              {items.map((i) => (
                <A key={i.href} href={i.href} className={menuLink}>
                  {i.label}
                </A>
              ))}
              <A href="/eligibility-checker" className={menuLink}>
                Eligibility checker
              </A>
              <A href="/help" className={menuLink}>
                Help
              </A>
              {signedIn ? (
                <>
                  {ACCOUNT_NAV.map((i) => (
                    <A key={i.href} href={i.href} className={menuLink}>
                      {i.label}
                    </A>
                  ))}
                  <SignOut className={menuLink} />
                </>
              ) : (
                <>
                  <A href="/employers" className={menuLink}>
                    For employers
                  </A>
                  <Button href="/signup">Create free account</Button>
                  <Button href="/login" variant="outline">
                    Sign in
                  </Button>
                </>
              )}
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}

const FOOTER_GROUPS = [
  { title: "Candidates", links: [["Find a job", "/jobs"], ["Companies", "/companies"], ["Eligibility checker", "/eligibility-checker"], ["Guides", "/guides"], ["Government updates", "/updates"]] },
  { title: "Employers", links: [["For employers", "/employers"], ["Permit services", "/permit-services"]] },
  { title: SITE_WORDMARK, links: [["Help and contact", "/help"], ["Terms", "/terms"], ["Privacy", "/privacy"], ["Cookies", "/cookies"]] },
] as const;

const EXT = { target: "_blank", rel: "noopener noreferrer", className: "underline underline-offset-2" } as const;

/**
 * The dark footer with rounded top corners (frame N01). A page whose last block is a dark band marked data-join (the home page's join band)
 * runs straight into it: the footer then drops its gap and corners. `standingLine` and `rulesCheckedOn` come from the page's data, never typed here.
 */
export function SiteFooter({ standingLine, rulesCheckedOn }: { standingLine?: ReactNode; rulesCheckedOn?: string }) {
  return (
    <footer className="mt-16 rounded-t-[2.5rem] bg-ink text-white/75 [main:has(>[data-join]:last-child)+&]:mt-0 [main:has(>[data-join]:last-child)+&]:rounded-none">
      <div className="mx-auto grid max-w-page gap-10 px-5 pb-10 pt-14 sm:px-8 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div className="flex flex-col gap-3">
          <Wordmark dark />
          <p className="max-w-xs text-small">Jobs in Ireland where an employment permit is realistic. Free for candidates.</p>
          <p className="max-w-xs text-small text-peach">
            No genuine employer asks you to pay for a job offer. <A href="/report" className="underline underline-offset-2">Report it.</A>
          </p>
        </div>
        {FOOTER_GROUPS.map((g) => (
          <nav key={g.title} aria-label={g.title}>
            <h2 className="mb-2 text-base text-white">{g.title}</h2>
            <ul className="flex flex-col">
              {g.links.map(([label, href]) => (
                <li key={href}>
                  <A href={href} className="inline-flex min-h-9 items-center text-small underline-offset-2 hover:text-white hover:underline">
                    {label}
                  </A>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <div className="mx-auto max-w-page space-y-2 border-t border-white/15 px-5 py-6 sm:px-8 text-small text-white/60">
        {standingLine && <p data-slot="standing-line">{standingLine}</p>}
        {rulesCheckedOn && <p data-slot="rules-checked-on">Rules last checked on {rulesCheckedOn}</p>}
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
