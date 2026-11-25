"use client";
// One button or small form that posts to a documented staff route (the browser adds the Origin header the route checks), shows the route's answer in plain words and
// refreshes the page. Every page of the contact, employer job, pay floor, account, company and seed screens builds its actions from this: the server page names the
// route, the fixed part of the body and the fields; the route checks the role, the claim and the Origin again. A decision can ask to confirm first. An answer of
// reauth_required sends the person to sign in again and back to this page (`here`), nothing lost but the form.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { A, Button, type ButtonVariant, Checkbox, Dialog, Input, Notice, Select, Textarea } from "@portal/ui";
import { postJson } from "./post";
import { staffWords } from "./staff-words";

type Base = { name: string; label: string; help?: string };
export type Field =
  | (Base & { kind: "text" | "textarea"; maxLength: number; required?: boolean; optional?: boolean })
  | (Base & { kind: "number"; min: number; max: number })
  | (Base & { kind: "select"; options: readonly (readonly [string, string])[] })
  | (Base & { kind: "check" })
  | (Base & { kind: "datetime" }); // a day and time on the officer's own clock; the body carries it as ISO with the zone (the case routes' receivedAt)

export type ActProps = {
  url: string; fixed: Record<string, unknown>; fields?: Field[]; label: string; variant?: ButtonVariant;
  /** When set, a dialog says this first and the action runs on its button. */
  confirm?: string; /** The address of this page (path and query), where a fresh sign-in comes back to. */ here: string;
  /** Where to go after the action worked (the list, when the item is gone). */ leave?: string;
};
export type ActState = { pending: boolean; asking: boolean; error?: { code: string; text: string }; done?: string };
export type ActHandlers = { onSubmit: (e: FormEvent<HTMLFormElement>) => void; onConfirm: () => void; onCancel: () => void };

export const signInAgain = (here: string) => `/sign-in?again=1&next=${encodeURIComponent(here)}`;

export function ErrorNote({ error, here }: { error: { code: string; text: string }; here: string }) {
  return (
    <Notice kind="error">
      {error.text}
      {error.code === "reauth_required" && <> <A href={signInAgain(here)} className="font-semibold underline">Sign in again</A></>}
    </Notice>
  );
}

function FieldView({ f }: { f: Field }) {
  if (f.kind === "check") return <Checkbox name={f.name} label={f.label} help={f.help} />;
  if (f.kind === "select") return <Select name={f.name} label={f.label} help={f.help}>{f.options.map(([v, t]) => <option key={v} value={v}>{t}</option>)}</Select>;
  if (f.kind === "textarea") return <Textarea name={f.name} label={f.label} help={f.help} maxLength={f.maxLength} required={f.required} rows={8} />;
  if (f.kind === "datetime") return <Input name={f.name} label={f.label} help={f.help} type="datetime-local" required />;
  if (f.kind === "number") return <Input name={f.name} label={f.label} help={f.help} type="number" inputMode="numeric" min={f.min} max={f.max} step={1} required />;
  return <Input name={f.name} label={f.label} help={f.help} maxLength={f.maxLength} required={f.required} autoComplete="off" spellCheck={false} />;
}

export function ActView({ p, s, h }: { p: ActProps; s: ActState; h: ActHandlers }) {
  const fields = p.fields ?? [];
  return (
    <form onSubmit={h.onSubmit} className="flex flex-col gap-3" aria-busy={s.pending || undefined}>
      {fields.map((f) => <FieldView key={f.name} f={f} />)}
      {s.error && !s.asking && <ErrorNote error={s.error} here={p.here} />}
      {s.done && <Notice kind="success">{s.done}</Notice>}
      <Button type="submit" variant={p.variant ?? "primary"} disabled={s.pending} className="self-start">{p.label}</Button>
      {p.confirm !== undefined && (
        <Dialog open={s.asking} onClose={h.onCancel} title={`${p.label}?`}>
          <p className="mb-4">{p.confirm}</p>
          {s.error && <ErrorNote error={s.error} here={p.here} />}
          <div className="mt-4 flex gap-2">
            <Button type="button" variant={p.variant === "danger" ? "danger" : "primary"} onClick={h.onConfirm} disabled={s.pending}>{p.label}</Button>
            <Button type="button" variant="outline" onClick={h.onCancel}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </form>
  );
}

/** The body: the fixed part and each field's value (a number as a number, a tick as true or false, an empty optional text left out). */
export function bodyOf(fixed: Record<string, unknown>, fields: Field[], data: FormData): Record<string, unknown> {
  const body = { ...fixed };
  for (const f of fields) {
    const v = data.get(f.name);
    if (f.kind === "check") body[f.name] = v !== null;
    else if (f.kind === "number") body[f.name] = Number(v);
    else if (f.kind === "datetime") body[f.name] = typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : "";
    else if (typeof v === "string" && !((f.kind === "text" || f.kind === "textarea") && f.optional && v.trim() === "")) body[f.name] = f.kind === "textarea" ? v : v.trim();
  }
  return body;
}

export function Act(p: ActProps) {
  const router = useRouter();
  const [s, set] = useState<ActState>({ pending: false, asking: false });
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  async function send(el: HTMLFormElement) {
    set((o) => ({ ...o, pending: true, error: undefined, done: undefined }));
    const r = await postJson(p.url, bodyOf(p.fixed, p.fields ?? [], new FormData(el)));
    if (!r.ok) return set((o) => ({ ...o, pending: false, error: { code: r.error, text: staffWords(r.error, r.status, r.stage) } }));
    const n = r.body.sessionsEnded;
    set({ pending: false, asking: false, done: typeof n === "number" ? `Done. ${n} open ${n === 1 ? "session" : "sessions"} ended.` : "Done." });
    el.reset();
    if (p.leave) router.replace(p.leave);
    router.refresh();
  }
  const h: ActHandlers = {
    onSubmit: (e) => { e.preventDefault(); setForm(e.currentTarget); if (p.confirm !== undefined) set((o) => ({ ...o, asking: true, error: undefined })); else void send(e.currentTarget); },
    onConfirm: () => form && void send(form),
    onCancel: () => set((o) => ({ ...o, asking: false, error: undefined })),
  };
  return <ActView p={p} s={s} h={h} />;
}
