import type { ReactNode } from "react";
import { A, cx, Icon } from "@portal/ui";

export type CountTab = { label: string; count: number | string; href: string; active: boolean };

/** Frame D02's tabs: a label with its count in a lilac pill, the open one underlined in green. Links, so it needs no script. */
export function CountTabs({ items, label }: { items: CountTab[]; label: string }) {
  return (
    <nav aria-label={label} className="flex gap-1 overflow-x-auto border-b border-line">
      {items.map((t) => (
        <A key={t.label} href={t.href} aria-current={t.active ? "page" : undefined} className={cx("flex min-h-11 shrink-0 items-center gap-2 border-b-4 px-3 text-small font-semibold no-underline", t.active ? "border-deep-green text-deep-green" : "border-transparent text-ink hover:border-line")}>
          {t.label}
          {t.count !== "" && <span className="rounded-pill bg-lilac px-2 text-caption font-semibold leading-6 text-ink">{t.count}</span>}
        </A>
      ))}
    </nav>
  );
}

/** A check row of the detail cards (frames D02 and ND2): a green tick or an amber warning, the title and what was found. */
export function CheckRow({ ok, title, children }: { ok: boolean | null; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3 py-3.5">
      <span aria-hidden="true" className={cx("mt-0.5 grid size-6 shrink-0 place-items-center rounded-pill", ok === null ? "bg-sand text-muted" : ok ? "bg-green-tint text-deep-green" : "bg-peach text-ink")}><Icon name={ok === null ? "minus" : ok ? "check" : "warning"} size={14} /></span>
      <div className="min-w-0">
        <p className="font-semibold leading-snug">{title}<span className="sr-only">{ok === null ? ", not reached" : ok ? ", fine" : ", needs a look"}</span></p>
        <p className="text-small text-muted [overflow-wrap:anywhere]">{children}</p>
      </div>
    </li>
  );
}
