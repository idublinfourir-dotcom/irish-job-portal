// The guides index (frame C15), a pure view. Without chips, a featured guide or related guides (decision #287, Q48 and Q115, L23); the government updates card is the three newest updates.
import type { ReactNode } from "react";
import { A, EmptyState, Icon } from "@portal/ui";
import { dayText, dublinDay } from "../_content/dates";
import { PageHead, wrap } from "../_content/head";
import { Join } from "../jobs/parts";
import { coverFor } from "./photos";
import { guidePath, staticPath } from "../../lib/paths";

export type GuideItem = { slug: string; title: string; checkedOn: string | null };
export type UpdateItem = { slug: string; title: string; publishedAt: Date | string };
export type GuidesProps = { guides: GuideItem[]; updates: UpdateItem[] | null; signedIn: boolean };

function Card({ g }: { g: GuideItem }) {
  const checked = dayText(g.checkedOn), c = coverFor(g.slug);
  return (
    <article data-guide-card className="relative flex min-h-[170px] flex-col justify-between gap-6 rounded-bento bg-sand p-6 hover:bg-hover-light">
      {/* eslint-disable-next-line @next/next/no-img-element -- self-hosted, hashed by the build */}
      <img src={c.src} width={c.width} height={c.height} alt={c.alt} loading="lazy" className="aspect-video w-full rounded-card object-cover" />
      <h2 className="break-words text-[1.35rem] leading-snug"><A href={guidePath(g.slug)} className="no-underline after:absolute after:inset-0 after:rounded-bento hover:underline">{g.title}</A></h2>
      <p className="flex items-center justify-between gap-3 text-small text-muted">
        <span className="inline-flex items-center gap-1.5">{checked ? <><Icon name="check" size={14} />Checked on {checked}</> : "Not yet checked"}</span>
        <Icon name="arrow" size={16} className="text-deep-green" />
      </p>
    </article>
  );
}

function Updates({ updates }: { updates: UpdateItem[] | null }) {
  const all = staticPath("updates")!;
  return (
    <aside aria-labelledby="updates-h" className="flex flex-col gap-1 rounded-bento bg-ink p-6 text-white sm:p-7">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id="updates-h" className="text-[1.5rem] text-white">Government updates</h2>
        <A href={all} className="text-small font-semibold text-mint-on-dark underline-offset-2 hover:underline">See all</A>
      </div>
      {updates === null && <p className="border-t border-white/15 py-4 text-small text-white/85">The updates could not be loaded. Please try again in a moment.</p>}
      {updates?.length === 0 && <p className="border-t border-white/15 py-4 text-small text-white/85">There are no updates yet.</p>}
      {updates?.map((u) => (
        <A key={u.slug} href={all} className="group flex items-center justify-between gap-4 border-t border-white/15 py-4 text-white no-underline">
          <span className="min-w-0"><span className="block text-small text-white/75">{dublinDay(u.publishedAt)}</span><span className="block break-words font-semibold group-hover:underline">{u.title}</span></span>
          <Icon name="right" size={16} className="shrink-0" />
        </A>
      ))}
    </aside>
  );
}

export function GuidesView({ guides, updates, signedIn }: GuidesProps): ReactNode {
  return (
    <>
      <div className={`${wrap} pb-8`}>
        <PageHead crumbs={[{ label: "Home", href: "/" }, { label: "Guides" }]} title="Guides and government updates" lead="Plain-English guides. Each one shows when we last checked it against its DETE source." />
        <div className="mt-8 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_23rem]">
          {guides.length === 0 ? (
            <EmptyState icon="file" title="No guides yet">Guides will appear here when they are published.</EmptyState>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">{guides.map((g) => <Card key={g.slug} g={g} />)}</div>
          )}
          <Updates updates={updates} />
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}
