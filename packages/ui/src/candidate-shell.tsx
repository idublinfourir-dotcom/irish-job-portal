import { A } from "./link";
import type { ReactNode } from "react";
import { Button } from "./button";
import { cx, SITE_NAME, SITE_WORDMARK } from "./cx";
import { Icon } from "./icons";
import { SignOut } from "./sign-out";
import { NavPill } from "./nav-pill";

/**
 * The companies directory (frame C13) waits for B25 and B26 (the directory read), so its link is hidden in all three places it appears (the header, the phone menu, the footer) from this
 * ONE switch. Set it to true when the directory page is built; nothing else changes. A company's own page (/companies/<slug>) is not the directory and is linked from jobs.
 */
export const COMPANIES_DIRECTORY_LIVE = false;
/**
 * Stage 3 step 8 (PERF-5): the candidate routes the CDN caches (legal, guides, help, occupation pages). Their links prefetch again: a prefetch is a CDN hit,
 * not a function run. Keep in step with the pages that export `revalidate` (packages/db/test/step16-w3-pages.test.ts lists them).
 */
export const cachedRoute = (href: string) => /^\/(privacy|terms|cookies|employer-acceptable-use|data-retention|guides|help)(\/[^/?#]+)?$|^\/occupations\/[^/?#]+$/.test(href);
const listed = <T extends { href: string }>(items: readonly T[]): T[] => items.filter((i) => COMPANIES_DIRECTORY_LIVE || i.href !== "/companies");

// Paths are placeholders until the page slices fix them (#288); change them here only. The header follows frame N01: five links, then the
// employer link, Sign in and the main button; the eligibility checker sits in the footer and the mobile menu.
const PUBLIC_NAV_ALL = [
  { label: "Home", href: "/" },
  { label: "Find a job", href: "/jobs" },
  { label: "Companies", href: "/companies" },
  { label: "Guides", href: "/guides" },
  { label: "Permit services", href: "/permit-services" },
];
// The account menu (frame M08 and the signed-in header of NA1): the public links stay in the bar.
const ACCOUNT_NAV = [
  { label: "Account", href: "/account" },
  { label: "Tracker", href: "/account/applications" },
  { label: "Saved", href: "/account/saved" },
  { label: "Alerts", href: "/account/alerts" },
];

// Compact between 1024 and 1280 (a laptop at 125 percent scaling is about 1093 px wide), the frame's spacing from 1280.
const link = "inline-flex min-h-11 items-center whitespace-nowrap px-1.5 text-[14px] font-medium text-ink/80 hover:text-ink xl:px-2 xl:text-[15px]";
const menuRow = "flex min-h-14 items-center justify-between border-b border-white/15 font-heading text-[22px] font-semibold";
// The phone menu's public links (frame M08), in its order.
const MOBILE_NAV_ALL = [
  { label: "Find a job", href: "/jobs" },
  { label: "Companies", href: "/companies" },
  { label: "Guides", href: "/guides" },
  { label: "Eligibility checker", href: "/eligibility-checker" },
  { label: "Permit services", href: "/permit-services" },
  { label: "Help", href: "/help" },
];
const menuLink = "inline-flex min-h-11 items-center px-2 font-semibold hover:underline underline-offset-4";

const SignOutHere = ({ className = link }: { className?: string }) => <SignOut action="/api/auth/candidate/sign-out" to="/" className={cx(className, "cursor-pointer")} />;

/** The logo (frame NS7): the domain in Outfit semibold, mint; on a dark surface white with a light mint ".ie". Text, not the pack's SVG: same letters, no file. */
export function Wordmark({ className, dark }: { className?: string; dark?: boolean }) {
  const [name, tld] = SITE_WORDMARK.split(/(?=\.)/);
  return (
    <A href="/" aria-label={`${SITE_NAME}, home`} className={cx("font-heading text-[22px] font-semibold tracking-tight no-underline", dark ? "text-white" : "text-deep-green", className)}>
      {dark ? <>{name}<span className="text-mint-on-dark">{tld}</span></> : SITE_WORDMARK}
    </A>
  );
}

/**
 * Stage 3 step 4 (AUDIT section 5, blocker 1): with `signedIn` left out, both variants are rendered, marked [data-in-only] and [data-out-only]; the
 * candidate app's hint cookie script (apps/candidate/lib/hint.ts) marks <html data-in> and its globals.css shows one. One HTML for everyone.
 */
/** One of two variants: the known one when the server knows (`signedIn` a boolean), both under the hint's CSS switch when it does not (undefined). */
function Either({ signedIn, yes, no }: { signedIn: boolean | undefined; yes: ReactNode; no: ReactNode }) {
  if (signedIn !== undefined) return <>{signedIn ? yes : no}</>;
  return (
    <>
      {yes && <div data-in-only="" className="contents">{yes}</div>}
      {no && <div data-out-only="" className="contents">{no}</div>}
    </>
  );
}

/**
 * The public header, or the signed-in one when `signedIn`: a floating bar (frame N01). The mobile menu is a native <details>, so it needs no script.
 * `signedIn` left out: both, switched by the hint cookie (HINT_SCRIPT), so the HTML is the same for every visitor.
 */
export function SiteHeader({ signedIn }: { signedIn?: boolean }) {
  const items = listed(PUBLIC_NAV_ALL);
  return (
    <header className="relative z-30 px-5 pt-4 sm:px-8 sm:pt-5">
      <div className="mx-auto flex max-w-[75rem] items-center justify-between gap-3 rounded-card bg-linear-to-b from-white to-hover-light py-2 pl-5 pr-2 shadow-pop sm:pl-6">
        <Wordmark />
        <nav aria-label="Main" className="hidden flex-1 items-center lg:flex">
          <NavPill className="flex flex-1 items-center justify-center gap-1">
            {items.map((i) => (
              <A key={i.href} href={i.href} prefetch={cachedRoute(i.href)} className={i.href === "/" ? link.replace("inline-flex", "hidden xl:inline-flex") : link}>
                {i.label}
              </A>
            ))}
          </NavPill>
          <Either
            signedIn={signedIn}
            yes={
            <div className="flex items-center gap-2">
              <A href="/account/notices" aria-label="Notices" className="grid size-11 place-items-center rounded-pill bg-white text-ink hover:bg-hover-light">
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
                  <SignOutHere className={menuLink} />
                </div>
              </details>
            </div>
            }
            no={
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
            }
          />
        </nav>
        <div className="flex items-center gap-2 lg:hidden">
          <Either
            signedIn={signedIn}
            yes={null}
            no={
              <A href="/login" className="hidden px-2 text-small font-semibold min-[360px]:inline">
                Sign in
              </A>
            }
          />
          <details className="group relative" data-menu>
            <summary className="grid size-11 cursor-pointer list-none place-items-center rounded-pill bg-ink text-white group-open:bg-hover-light group-open:text-ink" aria-label="Menu">
              <Icon name="menu" className="group-open:hidden" />
              <Icon name="close" className="hidden group-open:block" />
            </summary>
            {/* Frame M08: the rest of the screen under the bar, dark, one big row per link. */}
            <nav aria-label="Mobile" className="fixed inset-x-0 bottom-0 top-[5.25rem] z-10 flex flex-col overflow-y-auto bg-ink px-5 pb-8 pt-4 text-white sm:px-8">
              {listed(MOBILE_NAV_ALL).map((i) => (
                <A key={i.href} href={i.href} prefetch={cachedRoute(i.href)} className={menuRow}>
                  {i.label} <Icon name="arrow" />
                </A>
              ))}
              <Either
                signedIn={signedIn}
                yes={
                <>
                  {ACCOUNT_NAV.map((i) => (
                    <A key={i.href} href={i.href} className={menuRow}>
                      {i.label} <Icon name="arrow" />
                    </A>
                  ))}
                  <SignOutHere className="mt-6 inline-flex min-h-11 w-full items-center justify-center font-semibold" />
                </>
                }
                no={
                <div className="mt-7 flex flex-col items-center gap-4">
                  <Button href="/signup" variant="sun" size="lg" className="w-full">Create free account</Button>
                  <A href="/login" className="inline-flex min-h-11 items-center font-semibold">Sign in</A>
                  <A href="/employers" className="inline-flex min-h-11 items-center gap-2 text-small text-white/70">For employers and agencies <Icon name="external" size={16} /></A>
                </div>
                }
              />
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
 * The credit CC BY 4.0 asks every product that uses the data to show: the licence's own sentence (opendata.cro.ie/about, data.gov.ie/pages/opendatalicence), each source, the
 * licence link, and that we changed the data. CRO: CC BY 4.0. DETE: the PSI licence (enterprise.gov.ie/en/re-use-of-public-service-info), which Circular 12/2016 made CC BY.
 */
export function PublicDataCredit() {
  return (
    <p data-slot="public-data-credit">
      Contains Irish Public Sector Data licensed under a <A href="https://creativecommons.org/licenses/by/4.0/" {...EXT}>Creative Commons Attribution 4.0 International (CC BY 4.0) licence</A>.
      {" "}Sources: <A href="https://enterprise.gov.ie/en/what-we-do/workplace-and-skills/employment-permits/statistics/" {...EXT}>Department of Enterprise, Tourism and Employment</A> (permits)
      {" "}and <A href="https://opendata.cro.ie/dataset/companies" {...EXT}>Companies Registration Office</A> (company records), adapted by us.
    </p>
  );
}

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
        {FOOTER_GROUPS.map((g) => ({ ...g, links: g.links.filter(([, href]) => COMPANIES_DIRECTORY_LIVE || href !== "/companies") })).map((g) => (
          <nav key={g.title} aria-label={g.title}>
            <h2 className="mb-2 text-base text-white">{g.title}</h2>
            <ul className="flex flex-col">
              {g.links.map(([label, href]) => (
                <li key={href}>
                  <A href={href} prefetch={cachedRoute(href)} className="inline-flex min-h-9 items-center text-small underline-offset-2 hover:text-white hover:underline">
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
        <PublicDataCredit />
        <p>
          Place names adapted from <A href="https://www.geonames.org/" {...EXT}>GeoNames</A>, licensed <A href="https://creativecommons.org/licenses/by/4.0/" {...EXT}>CC BY 4.0</A>
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
export function CandidateShell({ children, signedIn, standingLine, rulesCheckedOn }: { children: ReactNode; signedIn?: boolean; standingLine?: ReactNode; rulesCheckedOn?: string }) {
  return (
    <div className="flex min-h-screen flex-col">
      <A href="#main" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <SiteHeader signedIn={signedIn} />
      <main id="main" className="flex-1">{children}</main>
      <SiteFooter standingLine={standingLine} rulesCheckedOn={rulesCheckedOn} />
    </div>
  );
}
