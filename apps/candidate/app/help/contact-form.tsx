"use client";
// The contact form of the help page (frame C21): POST /api/contact. A visitor gives a name and an email; a signed-in candidate does not (the account's are used). Every error code the route
// can answer has its words (app/jobs/api.ts: 400, 403 bot and origin, 413, 429); the reply is only `{ ok: true }`, so the form never says whether an email has an account.
import { useState, useSyncExternalStore } from "react";
import { Button, Icon, Input, Notice, Select, Textarea } from "@portal/ui";
import { CONTACT_TOPICS, MESSAGE_MAX, sendContact } from "../_content/api";

const noChange = () => () => {}; // the hint is read once a render; it changes only with a sign-in or sign-out, which reload the page
/** `signedIn` undefined (the cached /help): the visitor form first, then the hint cookie (lib/hint.ts) after hydration; POST /api/contact decides from the real session. */
export function ContactForm({ signedIn: known }: { signedIn?: boolean }) {
  const hinted = useSyncExternalStore(noChange, () => /(?:^|;\s*)cand_in=1(?:;|$)/.test(document.cookie), () => false); // the server and the first paint: a visitor
  const signedIn = known ?? hinted;
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sending" } | { kind: "done" } | { kind: "error"; message: string }>({ kind: "idle" });
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const text = (k: string) => String(f.get(k) ?? "");
    setState({ kind: "sending" });
    const r = await sendContact(text("topic"), text("body"), signedIn ? null : { name: text("name"), email: text("email") });
    if (r.ok) e.currentTarget.reset();
    setState(r.ok ? { kind: "done" } : { kind: "error", message: r.message });
  }
  return (
    <form onSubmit={submit} aria-label="Contact us" className="flex flex-col gap-4 rounded-bento bg-sand p-6 sm:p-8">
      <h2 className="text-[1.5rem]">Contact us</h2>
      {state.kind === "done" && <Notice kind="success" title="Thank you. We have your message.">We read every message and reply by email.</Notice>}
      {!signedIn && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Input name="name" label="Your name" autoComplete="name" required maxLength={120} />
          <Input name="email" type="email" label="Email" autoComplete="email" required maxLength={254} />
        </div>
      )}
      <Select name="topic" label="What is it about?" defaultValue="general">
        {CONTACT_TOPICS.filter(([k]) => signedIn ? k !== "appeal" : true).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </Select>
      <Textarea name="body" label="Message" required maxLength={MESSAGE_MAX} rows={5} placeholder="Tell us what happened." />
      {state.kind === "error" && <Notice kind="error">{state.message}</Notice>}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="dark" size="lg" disabled={state.kind === "sending"}><Icon name="send" size={16} />Send message</Button>
        <p className="text-small text-muted">We read every message and reply by email.</p>
      </div>
    </form>
  );
}
