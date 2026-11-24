// The head of a content page (frames C14 to C25): the breadcrumb, then the title with its last words in the accent colour, then the lead line.
import type { ReactNode } from "react";
import { Breadcrumb } from "@portal/ui";

/** A title with its last `n` words in green (frame NS2: key words only). A title of one or two words keeps one accent word at most. */
export function Accent({ text, n = 2 }: { text: string; n?: number }) {
  const w = text.split(/\s+/).filter(Boolean);
  const k = w.length >= 4 ? n : w.length >= 2 ? 1 : 0;
  if (k === 0) return <>{text}</>;
  return <>{w.slice(0, -k).join(" ")} <span className="text-deep-green">{w.slice(-k).join(" ")}</span></>;
}

export const wrap = "mx-auto max-w-page px-5 sm:px-8";

export function PageHead({ crumbs, title, lead, side, n }: { crumbs: { label: string; href?: string }[]; title: string; lead?: ReactNode; side?: ReactNode; n?: number }) {
  return (
    <div className="pb-2 pt-6 sm:pt-8">
      <Breadcrumb items={crumbs} />
      <div className="mt-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="break-words"><Accent text={title} n={n} /></h1>
          {lead && <p className="mt-3 max-w-[40rem] text-lead text-muted">{lead}</p>}
        </div>
        {side}
      </div>
    </div>
  );
}

const MARK = { tint: "bg-green-tint", peach: "bg-peach", lilac: "bg-lilac" } as const;
/** A key word of a section title on a coloured band (frame NS2: at most two a line). */
export const Mark = ({ tone, children }: { tone: keyof typeof MARK; children: ReactNode }) => <span className={`inline-block rounded-[0.28em] px-[0.22em] pb-[0.04em] leading-[1.2] ${MARK[tone]}`}>{children}</span>;

/** A section title of the content pages: plain words, then the key words on a band. */
export const SectionTitle = ({ id, children, className = "" }: { id?: string; children: ReactNode; className?: string }) => (
  <h2 id={id} className={`break-words text-[2rem] leading-[1.35] sm:text-[2.75rem] ${className}`}>{children}</h2>
);
