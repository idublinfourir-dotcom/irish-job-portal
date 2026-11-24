// The frame of the employer pages a visitor sees (the root layout gives a visitor the bare page, so each page brings its own header and footer, P13).
// Paths here are the pages of this slice; the candidate site's pages come from candidateHref and are left out when its address is not set.
import type { ReactNode } from "react";
import { A, Button, Icon, Wordmark } from "@portal/ui";

const link = "min-h-11 items-center whitespace-nowrap px-2 text-[14px] font-medium text-ink/80 hover:text-ink xl:text-[15px]";

/** The floating bar (frame NE1): the logo with "for employers", the way in. `candidates` is the candidate site's address, null hides the link. */
export function PublicHeader({ candidates }: { candidates?: string | null }) {
  return (
    <header className="relative z-30">
      <div className="flex items-center justify-between gap-3 rounded-card bg-linear-to-b from-white to-hover-light py-2 pl-5 pr-2 shadow-pop sm:pl-6">
        <div className="flex min-w-0 items-baseline gap-2">
          <Wordmark />
          <span className="hidden text-small font-semibold text-ink sm:inline">for employers</span>
        </div>
        <nav aria-label="Main" className="flex items-center gap-1">
          <A href="/#paths" className={`${link} hidden lg:inline-flex`}>How it works</A>
          {candidates && <A href={candidates} className={`${link} hidden md:inline-flex`}>For candidates</A>}
          <A href="/sign-in" className={`${link} inline-flex`}>Sign in</A>
          <span className="hidden min-[480px]:inline-flex"><Button href="/sign-up" size="lg">Create account <Icon name="arrow" size={16} /></Button></span>
        </nav>
      </div>
    </header>
  );
}

/** "Terms · Privacy · Help" under every sign-up page (frames E02 to E06). */
export function LegalLine({ help }: { help?: string | null }) {
  const a = "inline-flex min-h-9 items-center underline-offset-2 hover:underline";
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-small text-muted">
      <A href="/terms" className={a}>Terms</A>·<A href="/privacy" className={a}>Privacy</A>
      {help && <>·<A href={help} className={a}>Help</A></>}
    </p>
  );
}

/** The page frame: the header, the page. */
export function Page({ candidates, children }: { candidates?: string | null; children: ReactNode }) {
  return (
    <>
      <A href="#content" className="sr-only focus:not-sr-only focus:p-3">Skip to content</A>
      <PublicHeader candidates={candidates} />
      <div id="content">{children}</div>
    </>
  );
}
