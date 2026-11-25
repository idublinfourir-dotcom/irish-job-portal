// The content editor (frame D12) as parts that take their data as props, so a test renders every state. Tabs by kind (updates feed, guides, help, occupation pages) and the list of
// published pages not checked lately; a list on the left, the open page's form or its preview on the right. No "Email me updates" (CF38, Q46).
import { A, Button, EmptyState, Notice, Pager, Pill, Tabs } from "@portal/ui";
import { ContentForm, type Item } from "./actions";
import { categoryLabel, dayText, daysSince, isTab, KIND_WORD, STATE, TABS, type Kind, type Tab } from "./text";

export { isTab };
export type Row = { id: string; kind: string; slug: string; title: string; status: string; checkedOn: string | null; category: string | null; effectiveFrom: string | null };
export type Preview = { title: string; kind: string; body: string; sourceUrl: string | null; checkedOn: string | null; status: string; category: string | null; effectiveFrom: string | null };

export const href = (tab: Tab, o: { id?: string; after?: string; preview?: boolean; isNew?: boolean } = {}) =>
  `/content${new URLSearchParams({ ...(tab === "update" ? {} : { tab }), ...(o.id ? { id: o.id } : {}), ...(o.preview ? { preview: "1" } : {}), ...(o.isNew ? { new: "1" } : {}), ...(o.after ? { after: o.after } : {}) }).toString().replace(/^(?=.)/, "?")}`;

export function List({ tab, items, selected, now, next, prev }: { tab: Tab; items: Row[]; selected?: string; now: Date; next?: string; prev?: string }) {
  if (items.length === 0)
    return <EmptyState icon="file" title={tab === "stale" ? "Nothing is out of date" : `No ${tab === "update" ? "updates" : tab === "occupation" ? "occupation pages" : tab === "guide" ? "guides" : "help pages"} yet`}>{tab === "stale" ? "Every published guide, help and occupation page was checked lately." : "Pages appear here as they are written."}</EmptyState>;
  const stale = tab === "stale", feed = tab === "update";
  const cols = stale ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_4rem]" : feed ? "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_6rem_minmax(0,1fr)]" : "sm:grid-cols-[minmax(0,2fr)_6rem_minmax(0,1fr)]";
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-card border border-line bg-white">
        <div aria-hidden="true" className={`hidden gap-3 border-b border-line px-4 py-3 text-small font-semibold sm:grid ${cols}`}>
          <span>Title</span>
          {stale ? <><span>Kind</span><span>Checked on</span><span className="text-right">Days</span></> : feed ? <><span>Type</span><span>Effective from</span><span>State</span><span>Checked on</span></> : <><span>State</span><span>Checked on</span></>}
        </div>
        <ul>
          {items.map((i) => (
            <li key={i.id} className={i.id === selected ? "border-b border-line bg-lilac last:border-b-0" : "border-b border-line odd:bg-sand/60 last:border-b-0"}>
              <A href={href(tab === "stale" ? (i.kind as Tab) : tab, { id: i.id })} aria-current={i.id === selected ? "true" : undefined} className={`grid min-h-14 items-center gap-x-3 gap-y-1 px-4 py-3 no-underline ${cols}`}>
                <span className="font-semibold [overflow-wrap:anywhere]">{i.title}</span>
                {stale ? (
                  <><span className="text-small">{KIND_WORD[i.kind as Kind] ?? i.kind}</span><span className="text-small">{dayText(i.checkedOn)}</span><span className="text-small sm:text-right">{i.checkedOn ? daysSince(i.checkedOn, now) : ""}</span></>
                ) : (
                  <>
                    {feed && <span className="text-small">{categoryLabel(i.category)}</span>}
                    {feed && <span className="text-small">{dayText(i.effectiveFrom)}</span>}
                    <span><Pill tone={STATE[i.status]?.tone ?? "neutral"} className="min-h-[28px] px-3">{STATE[i.status]?.label ?? i.status}</Pill></span>
                    <span className="text-small">{dayText(i.checkedOn)}</span>
                  </>
                )}
              </A>
            </li>
          ))}
        </ul>
      </div>
      {(next || prev) && <Pager prevHref={prev} nextHref={next} />}
    </div>
  );
}

/** The page as its public page is made (B74). Text only, never markup. */
export function PreviewCard({ p, closeHref }: { p: Preview; closeHref: string }) {
  return (
    <section aria-label={`Preview of ${p.title}`} className="flex flex-col gap-4 rounded-bento bg-sand p-5 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[22px]">Preview</h2>
        <Pill tone={STATE[p.status]?.tone ?? "neutral"}>{STATE[p.status]?.label ?? p.status}</Pill>
      </header>
      <Notice kind="info">This is the page as the public site makes it, whatever its state. Only a published page is public.</Notice>
      <article className="flex flex-col gap-3 rounded-card bg-white p-5">
        <h3 className="text-[24px] [overflow-wrap:anywhere]">{p.title}</h3>
        <p className="text-small text-muted">{[categoryLabel(p.category), p.effectiveFrom ? `Effective from ${dayText(p.effectiveFrom)}` : "", p.checkedOn ? `Checked on ${dayText(p.checkedOn)}` : ""].filter(Boolean).join(" · ")}</p>
        <p className="whitespace-pre-line [overflow-wrap:anywhere]">{p.body}</p>
        {p.sourceUrl && <p className="text-small text-muted [overflow-wrap:anywhere]">Source: {p.sourceUrl}</p>}
      </article>
      <Button href={closeHref} variant="outline" className="self-start">Back to the form</Button>
    </section>
  );
}

/** The whole page body. `open` is the item whose form shows (null: none, or a new page when `isNew`). */
export function Content({ tab, items, selected, open, preview, isNew, missingId, roles, today, now, next, prev }: {
  tab: Tab; items: Row[]; selected?: string; open: Item | null; preview: Preview | null; isNew: boolean; missingId?: boolean; roles: string[]; today: string; now: Date; next?: string; prev?: string;
}) {
  const formKind: Kind = (open?.kind as Kind | undefined) ?? (tab === "stale" ? "guide" : tab);
  const canWrite = roles.includes("content_editor");
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Content editor</h1>
          <p className="text-muted">Guides, help, occupation pages and the government updates feed.</p>
        </div>
        {canWrite && tab !== "stale" && <Button href={href(tab, { isNew: true })} size="md">New {KIND_WORD[tab as Kind]}</Button>}
      </header>
      <Tabs label="Content tabs" items={TABS.map(([k, label]) => ({ label, href: href(k), active: k === tab }))} />
      {missingId && <Notice kind="warning">That page was not found. Pick one from the list.</Notice>}
      {tab === "stale" && <Notice kind="info">Published guides, help and occupation pages whose checked-on day is long past. Open one, check it against the DETE page and set a new day.</Notice>}
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_28rem]">
        <List tab={tab} items={items} selected={selected} now={now} next={next} prev={prev} />
        {preview ? <PreviewCard p={preview} closeHref={href(tab, { id: selected })} />
          : (open || (isNew && canWrite)) && <ContentForm kind={formKind} item={open} roles={roles} today={today} back={href(tab, { id: open?.id, isNew: open ? false : isNew })} listHref={href(tab)} />}
        {!preview && !open && !isNew && !canWrite && <Notice kind="info">Only a content editor writes pages. A rules data editor publishes guides and occupation pages.</Notice>}
      </div>
    </div>
  );
}
