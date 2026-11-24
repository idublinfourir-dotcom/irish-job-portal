import type { ReactNode } from "react";
import { A, Icon, type IconName } from "@portal/ui";

/** The two small cards under the dark panel (frames C24, C26, C27 and NS3). Free for candidates: our permit services are paid by the employer or agency (#83, #84), so the card says that, not the frame's "permit fees depend on the permit type" (Q130). */
export function SideCards() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <p className="rounded-bento bg-peach p-7 pr-16 font-medium">Free for candidates. The job board is always free. Our permit services are paid by the employer or agency, never by you.</p>
      <p className="rounded-bento bg-ink p-7 pr-16 font-medium text-white">Two badges, two sources: the employer&apos;s claim and our rule check.</p>
    </div>
  );
}

/**
 * The shared layout of the sign-in, verify, reset and "not for you" pages (frames C24, C26 and C27): the form on the left, a dark panel and two cards on the
 * right from 1024 px (nothing is lost on a phone: the panel only repeats the site's promise). `icon` is the round green badge above the heading (C24, C27).
 */
export function AuthFrame({ icon, title, lead, side, children }: { icon?: IconName; title: ReactNode; lead?: ReactNode; side: { title: ReactNode; lead: string }; children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-page gap-x-[88px] gap-y-6 px-5 py-6 sm:px-8 lg:grid-cols-[minmax(0,392px)_minmax(0,1fr)] lg:py-8">
      <div className="flex flex-col lg:min-h-[920px]">
        <div className="my-auto flex flex-col gap-6">
          {icon && <span aria-hidden="true" className="grid size-[52px] place-items-center rounded-pill bg-deep-green text-white"><Icon name={icon} size={24} /></span>}
          <div className="flex flex-col gap-3">
            <h1 className="lg:text-[32px] lg:leading-tight">{title}</h1>
            {lead && <p className="text-muted">{lead}</p>}
          </div>
          {children}
        </div>
        <p className="pt-10 text-caption text-muted">
          <A href="/terms" className="underline-offset-2 hover:underline">Terms</A> · <A href="/privacy" className="underline-offset-2 hover:underline">Privacy</A> · <A href="/help" className="underline-offset-2 hover:underline">Help</A>
        </p>
      </div>
      <div className="hidden flex-col gap-4 lg:flex" data-aside>
        <div className="flex flex-1 flex-col gap-4 rounded-bento bg-ink p-12 text-white">
          <p className="max-w-[26rem] font-heading text-[46px] font-semibold leading-[1.1] tracking-tight">{side.title}</p>
          <p className="max-w-[25rem] text-white/70">{side.lead}</p>
        </div>
        <SideCards />
      </div>
    </div>
  );
}

/** The dark panel's two-part heading: white, then the key words in light mint. */
export const Side = ({ a, b }: { a: string; b: string }) => <>{a} <span className="text-mint-on-dark">{b}</span></>;
