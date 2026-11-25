"use client";
// The content form (frame D12): create a draft, edit a draft or a withdrawn page, publish, withdraw. They post to POST /api/content (docs/openapi/admin.yaml), which checks the role
// (a content editor writes, a content editor publishes help and updates, a rules data editor publishes guides and occupation pages), the Origin, and the source and checked-on
// day a page needs. The body is a plain text box (Q2: the layout of guides, help and legal text waits). FormView takes its state as props so a test renders every state.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Dialog, Input, Select, Textarea } from "@portal/ui";
import { Failure } from "../_queue/failure";
import { PostButton } from "../_queue/post-button";
import { postJson } from "../_queue/post";
import { BODY_MAX, CATEGORIES, KIND_WORD, publisherRole, slugOf, STATE, TITLE_MAX, type Kind } from "./text";

export type Item = { id: string; kind: string; slug: string; title: string; status: string; body: string; sourceUrl: string | null; checkedOn: string | null; category: string | null; effectiveFrom: string | null };
export type Failed = { code: string; status: number } | null;
export type Props = { kind: Kind; item: Item | null; roles: string[]; today: string; back: string; listHref: string };
export type State = { pending: boolean; failed: Failed; ask: boolean };

export function FormView({ p, s, onSubmit, onAsk }: { p: Props; s: State; onSubmit: (e: FormEvent<HTMLFormElement>) => void; onAsk: (open: boolean) => void }) {
  const { kind, item, roles } = p;
  const canEdit = roles.includes("content_editor") && (item === null || item.status !== "published");
  const canPublish = roles.includes(publisherRole(kind)) && item?.status !== "published";
  const cats = CATEGORIES[kind];
  const fail = s.failed && <Failure code={s.failed.code} status={s.failed.status} back={p.back} />;
  const key = item?.id ?? "new";
  return (
    <form id="content-form" onSubmit={onSubmit} key={key} className="flex flex-col gap-4 rounded-bento bg-sand p-5 sm:p-6" aria-label={item ? `Edit ${item.title}` : `New ${KIND_WORD[kind]}`}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[22px]">{item ? "Edit" : "New"} {KIND_WORD[kind]}</h2>
        {item && <span className="rounded-pill bg-white px-3 text-small font-semibold leading-8">{STATE[item.status]?.label ?? item.status}</span>}
      </header>
      {item?.status === "published" && <p className="text-small text-muted">A published page cannot be edited. Withdraw it, change it, then publish it again.</p>}
      {item === null && !roles.includes("content_editor") && <p className="text-small text-muted">Only a content editor writes pages.</p>}
      <Input label="Title" name="title" required maxLength={TITLE_MAX} defaultValue={item?.title ?? ""} disabled={!canEdit} />
      {item === null && (
        <Input label="Address part" name="slug" maxLength={100} defaultValue="" disabled={!canEdit} placeholder={kind === "occupation" ? "2134" : "made from the title"}
          help={kind === "occupation" ? "The SOC 2010 code of the occupation." : "Lower-case letters, digits and hyphens. Left empty, it is made from the title. It cannot be changed later."} />
      )}
      {(cats.length > 0 || kind === "update") && (
        <div className="grid gap-4 sm:grid-cols-2">
          {cats.length > 0 && (
            <Select label={kind === "update" ? "Type" : "Group"} name="category" defaultValue={item?.category ?? cats[0]![0]} disabled={!canEdit}>
              {cats.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </Select>
          )}
          {kind === "update" && <Input label="Effective from" name="effectiveFrom" type="date" defaultValue={item?.effectiveFrom ?? ""} disabled={!canEdit} />}
        </div>
      )}
      <Textarea label="Text (plain English)" name="body" required rows={8} maxLength={BODY_MAX} defaultValue={item?.body ?? ""} disabled={!canEdit} help="Plain text, up to 50,000 characters. Line breaks are kept." />
      <Input label="DETE source link" name="sourceUrl" type="url" maxLength={500} defaultValue={item?.sourceUrl ?? ""} disabled={!canEdit} placeholder="https://enterprise.gov.ie/..." />
      <Input label="Checked on" name="checkedOn" type="date" max={p.today} defaultValue={item?.checkedOn ?? ""} disabled={!canEdit}
        help={kind === "help" ? "Shown on the page as \"Checked on\"." : "Needed to publish. Shown on the page as \"Checked on\"."} />
      {fail}
      <div className="flex flex-wrap gap-2">
        {canEdit && canPublish && <Button type="button" onClick={() => onAsk(true)} disabled={s.pending}>Publish</Button>}
        {canEdit && <Button type="submit" name="intent" value="draft" variant="chip" size="md" disabled={s.pending}>Save draft</Button>}
        {item && <Button href={`${p.listHref}${p.listHref.includes("?") ? "&" : "?"}id=${item.id}&preview=1`} variant="chip" size="md">Preview</Button>}
        {!canEdit && item && item.status !== "published" && canPublish && (
          <PostButton url="/api/content" body={{ action: "publish", id: item.id }} label="Publish" back={p.back}
            confirm={{ title: "Publish this page?", text: `${item.title} goes live on the public site at once.`, button: "Publish" }} />
        )}
        {item?.status === "published" && roles.includes("content_editor") && (
          <PostButton url="/api/content" body={{ action: "withdraw", id: item.id }} label="Withdraw" variant="danger" back={p.back}
            confirm={{ title: "Withdraw this page?", text: `${item.title} is taken off the public site. You can edit it and publish it again.`, button: "Withdraw" }} />
        )}
      </div>
      {canEdit && canPublish && (
      <Dialog open={s.ask} onClose={() => onAsk(false)} title="Publish this page?">
        <p className="mb-4">It is saved and goes live on the public site at once. A page that is not a help page needs its DETE source link and a checked-on day.</p>
        {fail}
        <div className="mt-4 flex gap-2">
          <Button type="submit" form="content-form" name="intent" value="publish" disabled={s.pending}>Publish</Button>
          <Button type="button" variant="outline" onClick={() => onAsk(false)}>Cancel</Button>
        </div>
      </Dialog>
      )}
    </form>
  );
}

const text = (f: FormData, k: string) => String(f.get(k) ?? "").trim();

export function ContentForm(p: Props) {
  const router = useRouter();
  const [s, set] = useState<State>({ pending: false, failed: null, ask: false });
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const intent = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value");
    const f = new FormData(e.currentTarget);
    const fields: Record<string, string> = { title: text(f, "title"), body: String(f.get("body") ?? "") };
    for (const k of ["sourceUrl", "checkedOn", "category", "effectiveFrom"]) if (text(f, k) !== "") fields[k] = text(f, k);
    set({ pending: true, failed: null, ask: s.ask });
    let id = p.item?.id;
    const saved = id
      ? await postJson("/api/content", { action: "edit", id, ...fields })
      : await postJson("/api/content", { action: "create", kind: p.kind, slug: text(f, "slug") || slugOf(fields.title!), ...fields });
    if (!saved.ok) return set({ pending: false, failed: { code: saved.error, status: saved.status }, ask: s.ask });
    id = typeof saved.body.id === "string" ? saved.body.id : id;
    if (intent === "publish") {
      const done = await postJson("/api/content", { action: "publish", id });
      if (!done.ok) { // the draft is saved: go to it, and say why it is not live
        router.replace(`${p.listHref}${p.listHref.includes("?") ? "&" : "?"}id=${id}`);
        return set({ pending: false, failed: { code: done.error, status: done.status }, ask: false });
      }
    }
    set({ pending: false, failed: null, ask: false });
    router.replace(`${p.listHref}${p.listHref.includes("?") ? "&" : "?"}id=${id}`);
    router.refresh();
  }
  return <FormView p={p} s={s} onSubmit={(e) => void onSubmit(e)} onAsk={(ask) => set({ ...s, ask, failed: ask ? null : s.failed })} />;
}
