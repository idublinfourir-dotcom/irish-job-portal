"use client";
// BA30, pattern of frames A09 and A10: change email (same domain only), sign out everywhere, the job-expiry notice switch, download my data, delete my login. Each calls a documented route
// from the browser (docs/openapi/portal.yaml, and the Better Auth routes under /api/auth/portal) and shows the words of _account/messages.ts. A route that answers REAUTH_REQUIRED sends the
// person to sign in again and back here (DD10, CF129).
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Dialog, Icon, Input, Notice, Toggle } from "@portal/ui";
import { AUTH } from "../(auth)/api";
import { go, reauth, send, type Reply } from "../_account/client";
import { needsReauth, say } from "../_account/messages";

export const CALLBACK = "/settings?email=confirm";
/** Row of a settings card: what it is, what it says now, and the control. */
export function Row({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="flex flex-wrap items-center justify-between gap-4 border-t border-line py-4 first:border-0"><div className="min-w-0"><p className="font-semibold">{title}</p>{children && <div className="text-small text-muted">{children}</div>}</div>{action}</div>;
}
/** Runs a call; a REAUTH answer goes to sign-in and back to /settings. Returns the answer, or null when the person was sent away. */
async function run(call: () => Promise<Reply>, setError: (m?: string) => void): Promise<Reply | null> {
  setError(undefined);
  const a = await call();
  if (needsReauth(a)) { setError(say(a)); await reauth("/settings"); return null; }
  return a;
}

export function ChangeEmail({ email }: { email: string }) {
  const [open, setOpen] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const newEmail = String(new FormData(e.currentTarget).get("newEmail") ?? "").trim();
    setPending(true);
    const a = await run(() => send(`${AUTH}/change-email`, "POST", { newEmail, callbackURL: CALLBACK }), setError);
    setPending(false);
    if (!a) return;
    if (a.status === 200) { setSent(true); return void setOpen(false); }
    setError(say(a));
  }
  return (
    <Row title="Email" action={<Button variant="chip" onClick={() => setOpen(!open)} aria-expanded={open}>Change</Button>}>
      {email}
      {sent && <Notice kind="success" title="Check your current email">We sent a link to your current address. Open it, then open the link we send to the new one. The address changes after both.</Notice>}
      {open && (
        <form onSubmit={onSubmit} className="mt-3 flex max-w-md flex-col gap-3 text-ink" aria-busy={pending || undefined}>
          <Input label="New email" name="newEmail" type="email" icon="mail" required maxLength={254} autoComplete="off" help="It must be on the same email domain as the current one." error={error} />
          <Button type="submit" variant="dark" disabled={pending} className="self-start">{pending ? "Sending" : "Send the confirmation link"}</Button>
        </form>
      )}
    </Row>
  );
}

export function SignOutEverywhere() {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function signOutAll() {
    setPending(true);
    const a = await run(() => send(`${AUTH}/revoke-sessions`, "POST", {}), setError);
    if (a?.status === 200) return void go("/sign-in");
    setPending(false);
    if (a) setError(say(a));
  }
  return (
    <Row title="Sign out everywhere" action={<Button variant="chip" onClick={signOutAll} disabled={pending}>{pending ? "Signing out" : "Sign out everywhere"}</Button>}>
      Ends every sign-in of this login, on every device, including this one.
      {error && <p role="alert" className="font-semibold text-error">{error}</p>}
    </Row>
  );
}

export function Reminder({ on }: { on: boolean }) {
  const [value, setValue] = useState(on), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function change(next: boolean) {
    setPending(true);
    const a = await run(() => send("/api/portal/notices/settings", "PUT", { job_expiry_reminder: next }), setError);
    setPending(false);
    if (!a) return;
    if (a.status === 200) return void setValue(next);
    setError(say(a));
  }
  return (
    <div className="flex flex-col gap-1">
      <Toggle label="Email me 3 days before a job I posted ends" checked={value} disabled={pending} onChange={(e) => void change(e.target.checked)}  error={error} />
      <p className="ml-14 text-small text-muted">The account owner also gets it for a job whose poster has gone. Security notices, such as a change of owner or being removed, are always sent.</p>
    </div>
  );
}

export function ExportData() {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function download() {
    setPending(true); setError(undefined);
    try {
      const res = await fetch("/api/portal/account/export", { credentials: "same-origin" });
      if (res.status === 200) {
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement("a");
        a.href = url; a.download = `my-data-${new Date().toISOString().slice(0, 10)}.json`; a.click();
        URL.revokeObjectURL(url);
      } else {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const answer = { status: res.status, code: body.code };
        if (needsReauth(answer)) { setError(say(answer)); return void (await reauth("/settings")); }
        setError(say(answer));
      }
    } catch { setError(say({ status: 0 })); }
    setPending(false);
  }
  return (
    <Row title="Download my data" action={<Button variant="chip" onClick={download} disabled={pending}><Icon name="download" size={16} />{pending ? "Preparing" : "Download"}</Button>}>
      A file with your own account data. It never holds another member&apos;s details.
      {error && <p role="alert" className="font-semibold text-error">{error}</p>}
    </Row>
  );
}

export function DeleteLogin() {
  const [open, setOpen] = useState(false), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (String(new FormData(e.currentTarget).get("word") ?? "").trim() !== "DELETE") return void setError("Type DELETE to confirm.");
    setPending(true);
    const a = await run(() => send("/api/portal/account", "DELETE", { confirm: true }), setError);
    if (a?.status === 200) return void go("/");
    setPending(false);
    if (a) setError(say(a));
  }
  return (
    <section aria-labelledby="delete-h" className="flex flex-col gap-3 rounded-bento bg-sand p-6 sm:p-8">
      <h2 id="delete-h" className="text-[22px] text-error">Delete my login</h2>
      <p className="text-muted">Deletes this login and its personal data. The company&apos;s own records stay. This cannot be undone. If you own the company, close it or transfer ownership first.</p>
      <Button variant="danger" onClick={() => setOpen(true)} className="self-start"><Icon name="trash" size={18} />Delete my login</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete your login?">
        <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-busy={pending || undefined}>
          <Notice kind="error" title="This cannot be undone">Your login is erased and every session ends. You can download your data first.</Notice>
          <Input label="Type DELETE to confirm" name="word" autoComplete="off" required />
          {error && <Notice kind="error">{error}</Notice>}
          <div className="flex flex-wrap gap-3">
            <Button variant="chip" onClick={() => setOpen(false)}>Keep my login</Button>
            <Button type="submit" variant="danger" disabled={pending}>{pending ? "Deleting" : "Delete my login and data"}</Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
