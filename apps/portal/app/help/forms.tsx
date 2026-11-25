"use client";
// Frame C21's contact form for the employer site (BA22). POST /api/portal/contact (docs/openapi/portal.yaml): a signed-in login sends general, account, data_request or other and its own name and
// email are used; a visitor (a blocked login holds no session) may send only `appeal`, with name and email. Sent, 429 and every refusal have their own words (_account/messages.ts).
import { useState, type FormEvent } from "react";
import { Button, Input, Notice, Select, Textarea } from "@portal/ui";
import { send } from "../_account/client";
import { MESSAGE_MAX, say } from "../_account/messages";

export const TOPICS: Record<string, string> = {
  general: "A question about the site",
  account: "My account or company",
  data_request: "My data: export or erase",
  other: "Something else",
  appeal: "My login is blocked or my account was banned",
};
/** The topics each kind of sender may pick: an active login not `appeal`, a visitor only `appeal`. */
export const topicsFor = (signedIn: boolean) => (signedIn ? ["general", "account", "data_request", "other"] : ["appeal"]);

export function ContactView({ signedIn, topic, sent, error, pending, onSubmit }: { signedIn: boolean; topic: string; sent?: boolean; error?: string; pending?: boolean; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  const topics = topicsFor(signedIn);
  if (sent) return <Notice kind="success" title="Message sent">Thank you. Our team reads every message and replies by email.</Notice>;
  return (
    <form onSubmit={onSubmit} id="contact-form" className="flex flex-col gap-5" aria-busy={pending || undefined}>
      {!signedIn && (
        <>
          <Notice kind="info" title="You are not signed in">You can write to us here about a login that is blocked or an account that was banned. For anything else, sign in first.</Notice>
          <div className="grid gap-5 sm:grid-cols-2">
            <Input label="Your name" name="name" required maxLength={120} autoComplete="name" />
            <Input label="Email" name="email" type="email" icon="mail" required maxLength={254} autoComplete="email" />
          </div>
        </>
      )}
      <Select label="What is it about?" name="topic" defaultValue={topics.includes(topic) ? topic : topics[0]}>
        {topics.map((t) => <option key={t} value={t}>{TOPICS[t]}</option>)}
      </Select>
      <Textarea label="Message" name="body" required maxLength={MESSAGE_MAX} rows={7} placeholder="Tell us what happened." />
      {error && <Notice kind="error">{error}</Notice>}
      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" variant="dark" size="lg" disabled={pending}>{pending ? "Sending" : "Send message"}</Button>
        <p className="text-small text-muted">Do not send passwords or card numbers.</p>
      </div>
    </form>
  );
}

export function ContactForm({ signedIn, topic }: { signedIn: boolean; topic: string }) {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const body = (f.body ?? "").trim();
    if (!body) return void setError("Write your message first.");
    setPending(true); setError(undefined);
    const a = await send("/api/portal/contact", "POST", { topic: signedIn ? f.topic : "appeal", body, ...(signedIn ? {} : { name: (f.name ?? "").trim(), email: (f.email ?? "").trim() }) });
    setPending(false);
    if (a.status === 200) return void setSent(true);
    setError(say(a));
  }
  return <ContactView signedIn={signedIn} topic={topic} sent={sent} error={error} pending={pending} onSubmit={onSubmit} />;
}
