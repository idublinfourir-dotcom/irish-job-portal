import { A } from "./link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

export type TabItem = { label: string; href?: string; active?: boolean };

/** Tabs: links when `href` is given, otherwise buttons for the page to wire. The active one is selected. */
export function Tabs({ items, label }: { items: TabItem[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((t) => {
        const cls = cx("min-h-11 shrink-0 border-b-4 px-4 font-semibold", t.active ? "border-deep-green text-ink" : "border-transparent text-muted hover:text-ink");
        return t.href ? (
          <A key={t.label} role="tab" aria-selected={!!t.active} href={t.href} className={cls}>
            {t.label}
          </A>
        ) : (
          <button key={t.label} type="button" role="tab" aria-selected={!!t.active} className={cls}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function Breadcrumb({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav aria-label="Breadcrumb">
      <ol className="flex flex-wrap items-center gap-1 text-small text-muted">
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <li key={c.label} className="flex items-center gap-1">
              {c.href && !last ? (
                <A href={c.href} className="underline underline-offset-2">
                  {c.label}
                </A>
              ) : (
                <span aria-current={last ? "page" : undefined} className={last ? "font-semibold text-ink" : undefined}>
                  {c.label}
                </span>
              )}
              {!last && <Icon name="right" size={14} />}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Previous and Next only, never page numbers (decision #125). A missing href shows the button off. */
export function Pager({ prevHref, nextHref }: { prevHref?: string; nextHref?: string }) {
  const one = (href: string | undefined, text: string, icon: "left" | "right") => {
    const cls = cx("inline-flex min-h-11 items-center gap-2 rounded-control border-2 px-4 font-semibold", href ? "border-ink hover:bg-hover-light" : "border-transparent bg-disabled text-disabled-ink");
    const body: ReactNode = icon === "left" ? (<><Icon name="left" size={16} />{text}</>) : (<>{text}<Icon name="right" size={16} /></>);
    return href ? (
      <A href={href} rel={text === "Previous" ? "prev" : "next"} className={cls}>
        {body}
      </A>
    ) : (
      <span aria-disabled="true" className={cls}>
        {body}
      </span>
    );
  };
  return (
    <nav aria-label="Pagination" className="flex justify-between gap-3">
      {one(prevHref, "Previous", "left")}
      {one(nextHref, "Next", "right")}
    </nav>
  );
}
