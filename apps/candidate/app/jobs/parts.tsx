// Small parts the job pages share: the page gutter, a highlighted heading word, the round logo and the dark "join" band the footer runs on from (frame N01).
import type { ReactNode } from "react";
import { Button, Icon } from "@portal/ui";
import { initials } from "./format";

export const wrap = "mx-auto max-w-page px-5 sm:px-8";

const HL = { peach: "bg-peach text-ink", green: "bg-deep-green text-white", lilac: "bg-lilac text-ink", white: "bg-white text-ink" } as const;
/** A heading's key word in a coloured pill (NS2: at most two pills a line). */
export function Hl({ c, children }: { c: keyof typeof HL; children: ReactNode }) {
  return <span className={`inline-block rounded-[0.28em] px-[0.22em] pb-[0.08em] ${HL[c]}`}>{children}</span>;
}

/** The employer's logo, or its initials on a white disc when it has none. No photo ships (NS6); a logo is the employer's own file. */
export function Logo({ name, url, className = "size-12" }: { name: string; url?: string | null; className?: string }) {
  return (
    <span aria-hidden="true" className={`grid shrink-0 place-items-center overflow-hidden rounded-pill bg-white font-heading text-[15px] font-semibold text-ink ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- a company logo from the portal's public store */}
      {url ? <img src={url} alt="" className="size-full object-contain p-1.5" /> : initials(name)}
    </span>
  );
}

/** A neutral block where a frame has a photo (NS6: no photo of the design ships). */
export function PhotoBlock({ className = "" }: { className?: string }) {
  return <div aria-hidden="true" data-photo-block className={`rounded-bento bg-lilac-soft ${className}`} />;
}

/** The dark join band the footer runs on from (frame N01): only for a visitor. data-join tells the footer to drop its gap and corners. */
export function Join() {
  return (
    <section data-join aria-labelledby="join-h" className="mt-12 rounded-t-[2.5rem] bg-ink text-white">
      <div className={`${wrap} flex flex-col items-start justify-between gap-8 border-b border-white/15 py-14 lg:flex-row lg:items-center`}>
        <h2 id="join-h" className="text-[2.4rem] leading-[1.3] text-white sm:text-[3.75rem]">
          Create a <Hl c="green">free</Hl> account{" "}
          <span aria-hidden="true" className="inline-grid size-[0.72em] place-items-center rounded-pill bg-peach align-[0.05em] text-ink"><Icon name="up-right" size={18} /></span>
          <br />and see <Hl c="peach">every job</Hl>
        </h2>
        <Button href="/signup" size="lg">Create free account <Icon name="arrow" size={16} /></Button>
      </div>
    </section>
  );
}
