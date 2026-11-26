// One guide (frame C16), a pure view: the head with its "Checked on" date and source, the body, and the card that leads to the eligibility checker.
import type { ReactNode } from "react";
import { A, Button, Icon, Pill } from "@portal/ui";
import { Body } from "../_content/body";
import { dayText } from "../_content/dates";
import { PageHead, wrap } from "../_content/head";
import { Join } from "../jobs/parts";
import { coverFor } from "./photos";
import { staticPath } from "../../lib/paths";

export type GuideData = { slug: string; title: string; body: string; sourceUrl: string | null; checkedOn: string | null };

/** The source's host for the link text, only for an http or https address; anything else is not linked. */
export function sourceOf(url: string | null): { host: string; href: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? { host: u.host.replace(/^www\./, ""), href: u.href } : null;
  } catch { return null; }
}

export function GuideView({ guide: g, signedIn }: { guide: GuideData; signedIn: boolean }): ReactNode {
  const checked = dayText(g.checkedOn);
  const src = sourceOf(g.sourceUrl), c = coverFor(g.slug);
  return (
    <>
      <div className={`${wrap} pb-10`}>
        <div className="grid items-start gap-x-10 lg:grid-cols-[minmax(0,1fr)_21rem]">
          <div className="min-w-0">
            <PageHead
              crumbs={[{ label: "Guides", href: "/guides" }, { label: g.title }]}
              title={g.title}
              n={0}
              lead={(checked || src) && (
                <span className="flex flex-wrap items-center gap-3 text-small">
                  {checked && <Pill tone="green" className="min-h-0 gap-1.5 px-3 py-[5px] text-[13px] text-pressed-dark"><Icon name="check" size={14} />Checked on {checked}</Pill>}
                  {src && <A href={src.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 font-semibold text-deep-green underline-offset-2 hover:underline"><Icon name="external" size={14} />Source: {src.host}</A>}
                </span>
              )}
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- self-hosted, hashed by the build */}
            <img src={c.src} width={c.width} height={c.height} alt={c.alt} loading="eager" fetchPriority="high" className="mt-6 aspect-video w-full max-w-[46rem] rounded-card object-cover" />
            <Body text={g.body} toc className="mt-6 max-w-[46rem] text-lead text-muted" />
          </div>
          <aside aria-labelledby="own-case" className="mt-8 flex flex-col gap-4 rounded-bento bg-ink p-6 text-white lg:sticky lg:top-6 lg:mt-[7.5rem]">
            <h2 id="own-case" className="text-[1.25rem] text-white">Check your own case</h2>
            <p className="text-small text-white/85">Occupation, salary, degree and contract length. Same rules as the badges.</p>
            <Button href={staticPath("eligibility-checker")!} size="md" className="self-start">Open the eligibility checker</Button>
          </aside>
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
