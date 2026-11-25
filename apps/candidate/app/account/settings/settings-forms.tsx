"use client";
// The interactive rows of /account/settings (frame A09): email, password, Google, sign out everywhere, the email switch and the data export. Each calls a
// documented route (docs/openapi/candidate.yaml) and says every answer in the words of ../settings-messages.ts. A route that answers REAUTH_REQUIRED (change of email,
// linking Google, export) shows the sign-in-again notice (DD10); the sign-in page brings the person back here.
import { useState, type FormEvent, type ReactNode } from "react";
import { Button, Input, Notice, Toggle } from "@portal/ui";
import { passwordProblem } from "../../(auth)/messages";
import { send } from "../send";
import { sayAccount } from "../settings-messages";
import { ReauthNotice } from "../reauth";
import { goodbyePath, settingsPath } from "../../../lib/paths";

const AUTH = "/api/auth/candidate";
type Flash = { kind: "ok" | "error"; text: string; reauth?: boolean } | undefined;
const fields = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

export function Row({ title, detail, action, children }: { title: string; detail?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-5 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0"><p className="font-semibold">{title}</p>{detail && <p className="break-words text-small text-muted">{detail}</p>}</div>
        {action}
      </div>
      {children}
    </div>
  );
}
const Say = ({ flash, back }: { flash: Flash; back: string }) =>
  !flash ? null : flash.reauth ? <ReauthNotice text={flash.text} back={back} /> : <Notice kind={flash.kind === "ok" ? "success" : "error"}>{flash.text}</Notice>;

export function EmailRow({ email, verified, flash: first }: { email: string; verified: boolean; flash?: Flash }) {
  const [open, setOpen] = useState(false), [flash, setFlash] = useState<Flash>(first), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setFlash(undefined);
    // callbackURL: both emailed links end on this page (`?email=link`), so they never end on the auth library's page.
    const r = await send("POST", `${AUTH}/change-email`, { newEmail: fields(e).newEmail!.trim(), callbackURL: `${settingsPath()}?email=link` });
    setBusy(false);
    if (r.ok) { setOpen(false); return void setFlash({ kind: "ok", text: "Check both inboxes. We sent a link to your current address first. When you open it we send a second link to the new address, and your address changes when you open that one. If the new address cannot be used we send nothing." }); }
    const s = sayAccount(r);
    setFlash({ kind: "error", text: s.text, reauth: s.reauth });
  }
  return (
    <Row title="Email" detail={`${email} · ${verified ? "verified" : "not verified yet"}`} action={<Button type="button" variant="chip" onClick={() => setOpen(!open)} aria-expanded={open}>Change</Button>}>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input label="New email address" name="newEmail" type="email" icon="mail" required maxLength={254} autoComplete="email" />
          <Button type="submit" variant="dark" disabled={busy} className="self-start">{busy ? "Sending" : "Send the links"}</Button>
        </form>
      )}
      <Say flash={flash} back={settingsPath()} />
    </Row>
  );
}

export function PasswordRow({ changedOn, hasPassword }: { changedOn: string | null; hasPassword: boolean }) {
  const [open, setOpen] = useState(false), [flash, setFlash] = useState<Flash>(), [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e);
    const problem = passwordProblem(f.newPassword!) ?? (f.newPassword === f.repeat ? undefined : "The two new passwords are not the same.");
    if (problem) return void setFlash({ kind: "error", text: problem });
    setBusy(true); setFlash(undefined);
    const r = await send("POST", `${AUTH}/change-password`, { currentPassword: f.currentPassword, newPassword: f.newPassword, revokeOtherSessions: f.others === "on" });
    setBusy(false);
    if (!r.ok) return void setFlash({ kind: "error", text: sayAccount(r).text });
    setOpen(false); setFlash({ kind: "ok", text: "Your password is changed." });
  }
  if (!hasPassword) return <Row title="Password" detail="You sign in with Google, so you have no password here. To add one, sign out and use Forgot password on the sign-in page." />;
  return (
    <Row title="Password" detail={changedOn ? `Last changed ${changedOn}` : undefined} action={<Button type="button" variant="chip" onClick={() => setOpen(!open)} aria-expanded={open}>Change</Button>}>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input label="Current password" name="currentPassword" type="password" icon="lock" required autoComplete="current-password" maxLength={128} />
          <Input label="New password" name="newPassword" type="password" icon="lock" required autoComplete="new-password" minLength={8} maxLength={128} help="At least 8 characters." />
          <Input label="New password again" name="repeat" type="password" icon="lock" required autoComplete="new-password" maxLength={128} />
          <label className="flex min-h-11 items-center gap-3"><input type="checkbox" name="others" defaultChecked className="size-5 accent-deep-green" />Sign me out of my other devices</label>
          <Button type="submit" variant="dark" disabled={busy} className="self-start">{busy ? "Saving" : "Change password"}</Button>
        </form>
      )}
      <Say flash={flash} back={settingsPath()} />
    </Row>
  );
}

const GOOGLE = /^https:\/\/accounts\.google\.com\//;
export function GoogleRow({ connected }: { connected: boolean }) {
  const [flash, setFlash] = useState<Flash>(), [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true); setFlash(undefined);
    const r = await send("POST", `${AUTH}/link-social`, { provider: "google", callbackURL: settingsPath() });
    setBusy(false);
    const url = r.json?.url;
    if (r.ok && typeof url === "string" && GOOGLE.test(url)) return void window.location.assign(url);
    const s = sayAccount(r.ok ? { ok: false, status: 500 } : r);
    setFlash({ kind: "error", text: s.text, reauth: s.reauth });
  }
  return (
    <Row title="Google" detail={connected ? "Connected. You can sign in with Google." : "Not connected"} action={connected ? undefined : <Button type="button" variant="chip" disabled={busy} onClick={() => void connect()}>Connect</Button>}>
      <Say flash={flash} back={settingsPath()} />
    </Row>
  );
}

export function SignOutAll() {
  const [busy, setBusy] = useState(false), [flash, setFlash] = useState<Flash>();
  async function go() {
    setBusy(true); setFlash(undefined);
    const r = await send("POST", `${AUTH}/revoke-sessions`, {});
    if (r.ok) return void window.location.replace("/");
    setBusy(false); setFlash({ kind: "error", text: sayAccount(r).text });
  }
  return (
    <Row title="Sign out everywhere" detail="Ends every sign-in of your account, on every device, this one too." action={<Button type="button" variant="chip" disabled={busy} onClick={() => void go()}>Sign out of all devices</Button>}>
      <Say flash={flash} back={settingsPath()} />
    </Row>
  );
}

export function JobAlertsSwitch({ on }: { on: boolean }) {
  const [value, setValue] = useState(on), [flash, setFlash] = useState<Flash>(), [busy, setBusy] = useState(false);
  async function change(next: boolean) {
    setBusy(true); setFlash(undefined);
    const r = await send("PUT", "/api/candidate/notifications", { job_alerts: next });
    setBusy(false);
    if (r.ok) return void setValue(next);
    setFlash({ kind: "error", text: sayAccount(r).text });
  }
  return (
    <div className="flex flex-col gap-2">
      <Toggle label="Job alerts by email" help="New jobs that match your alerts. Each alert also has its own pause." checked={value} disabled={busy} onChange={(e) => void change(e.currentTarget.checked)} />
      <Say flash={flash} back={settingsPath()} />
    </div>
  );
}

/** Download my data (CF62): the route answers a file after a sign-in in the last 10 minutes; older, it asks for a new sign-in. */
export function ExportRow() {
  const [busy, setBusy] = useState(false), [flash, setFlash] = useState<Flash>();
  async function go() {
    setBusy(true); setFlash(undefined);
    const r = await send("GET", "/api/candidate/export");
    setBusy(false);
    if (!r.ok || !r.response) { const s = sayAccount(r); return void setFlash({ kind: "error", text: s.text, reauth: s.reauth }); }
    const blob = await r.response.blob();
    const name = /filename="([^"]+)"/.exec(r.response.headers.get("content-disposition") ?? "")?.[1] ?? "my-data.json";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    URL.revokeObjectURL(a.href);
    setFlash({ kind: "ok", text: "Your data is downloaded." });
  }
  return (
    <Row title="Download my data" detail="A copy of your profile, CV details, saved jobs, alerts, tracker and permit cases, as one file. You need to have signed in in the last 10 minutes." action={<Button type="button" variant="chip" disabled={busy} onClick={() => void go()}>{busy ? "Preparing" : "Download"}</Button>}>
      <Say flash={flash} back={`${settingsPath()}#data`} />
    </Row>
  );
}

/** The confirmation of the delete page (frame A10): type DELETE, then the route (DELETE /api/candidate/account, a sign-in in the last 10 minutes). */
export function DeleteForm({ back, googleOnly }: { back: string; googleOnly: boolean }) {
  const [typed, setTyped] = useState(""), [busy, setBusy] = useState(false), [flash, setFlash] = useState<Flash>();
  async function go(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setFlash(undefined);
    const r = await send("DELETE", "/api/candidate/account", { confirm: true });
    if (r.ok) return void window.location.assign(goodbyePath());
    setBusy(false);
    const s = sayAccount(r);
    setFlash({ kind: "error", text: s.reauth && googleOnly ? "For your safety, sign in with Google again to do this. You come back to this page." : s.text, reauth: s.reauth });
  }
  return (
    <form onSubmit={go} className="flex flex-col gap-4">
      <Input label="Type DELETE to confirm" name="confirm" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      <Say flash={flash} back={back} />
      <div className="flex flex-wrap gap-3">
        <Button href={settingsPath()} variant="chip" size="md">Keep my account</Button>
        <Button type="submit" variant="danger" disabled={busy || typed !== "DELETE"}>{busy ? "Deleting" : "Delete account and data"}</Button>
      </div>
    </form>
  );
}
