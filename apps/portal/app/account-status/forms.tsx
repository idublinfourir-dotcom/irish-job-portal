"use client";
// Frame E20 (DD18): the reply form and the appeal form of one case. POST /api/portal/status (docs/openapi/portal.yaml). Text only (L8: no documents). An appeal needs a sign-in in the last
// 10 minutes: a REAUTH_REQUIRED answer sends the person to sign in again and back here (DD10, CF129). The words come from _account/messages.ts.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button, Notice, Textarea } from "@portal/ui";
import { reauth, send } from "../_account/client";
import { needsReauth, say, TEXT_MAX } from "../_account/messages";

export function CaseTextView({ kind, until, error, pending, onSubmit }: { kind: "reply" | "appeal"; until: string | null; error?: string; pending?: boolean; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  const reply = kind === "reply";
  return (
    <form onSubmit={onSubmit} data-form={kind} className="flex flex-col gap-3 rounded-card bg-white p-5" aria-busy={pending || undefined}>
      <h3 className="text-[20px]">{reply ? "Your reply" : "Appeal this decision"}</h3>
      <Textarea label={reply ? "What happened, and what shows it?" : "Why should we change the decision?"} name="text" required maxLength={TEXT_MAX} rows={6}
        help={`${reply ? "A reply" : "An appeal"} is sent once and cannot be changed. Text only, up to ${TEXT_MAX} characters.${until ? ` ${reply ? "Reply" : "Appeal"} by ${until}.` : ""}`} error={error} />
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="self-start">{pending ? "Sending" : reply ? "Send reply" : "Send appeal"}</Button>
    </form>
  );
}

export function CaseText({ caseId, kind, until }: { caseId: string; kind: "reply" | "appeal"; until: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const text = String(new FormData(e.currentTarget).get("text") ?? "").trim();
    if (!text) return void setError("Write something before you send it.");
    setPending(true); setError(undefined);
    const a = await send("/api/portal/status", "POST", { action: kind, caseId, text });
    if (needsReauth(a)) { setError(say(a)); return void (await reauth("/account-status")); }
    setPending(false);
    if (a.status === 200) { setSent(true); return void router.refresh(); }
    setError(say(a));
  }
  if (sent) return <Notice kind="success" title={kind === "reply" ? "Your reply was sent" : "Your appeal was sent"}>Our team will read it. You will be told what is decided.</Notice>;
  return <CaseTextView kind={kind} until={until} error={error} pending={pending} onSubmit={onSubmit} />;
}
