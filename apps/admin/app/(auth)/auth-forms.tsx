"use client";
// The three staff forms. Each posts JSON to the documented Better Auth route (docs/openapi/admin.yaml, /api/auth/staff/{path}) from the browser, which sends the
// Origin header the route checks, and shows the words of messages.ts for every answer. The View parts take their state as props, so a test renders every state.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { A, Button, Input, Notice } from "@portal/ui";
import { forgotMessage, INVALID_LINK, MAX_PASSWORD, MIN_PASSWORD, passwordProblem, resetMessage, SESSION_HOURS, signInMessage, type Answer } from "./messages";

const BASE = "/api/auth/staff";
async function post(path: string, body: object): Promise<Answer> {
  try {
    const res = await fetch(`${BASE}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    if (res.ok) return { status: res.status };
    const j = (await res.json().catch(() => null)) as { code?: unknown } | null;
    return { status: res.status, code: typeof j?.code === "string" ? j.code : undefined };
  } catch {
    return { status: 0 };
  }
}
const fields = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

export function SignInView({ error, pending, onSubmit }: { error?: string; pending?: boolean; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Email" name="email" type="email" autoComplete="username" required maxLength={254} />
      <Input label="Password" name="password" type="password" autoComplete="current-password" required maxLength={MAX_PASSWORD} error={error} />
      <A href="/forgot-password" className="self-end text-small font-semibold text-deep-green underline-offset-2 hover:underline">Forgot password?</A>
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Signing in" : "Sign in"}</Button>
      <p className="text-small text-muted">A staff session ends after {SESSION_HOURS} hours without use.</p>
    </form>
  );
}
export function SignInForm({ next }: { next?: string | null }) {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { email, password } = fields(e);
    setPending(true); setError(undefined);
    const a = await post("sign-in/email", { email: email!.trim(), password });
    if (a.status === 200) return void (router.replace(next ?? "/"), router.refresh()); // refresh: the layout reads the new session
    setError(signInMessage(a)); setPending(false);
  }
  return <SignInView error={error} pending={pending} onSubmit={onSubmit} />;
}

export function ForgotView({ error, pending, sent, onSubmit }: { error?: string; pending?: boolean; sent?: boolean; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  if (sent) return (
    <div className="flex flex-col gap-5">
      <Notice kind="success" title="Check your email">If that address belongs to a staff login, a link is on its way. It works for 1 hour and only once.</Notice>
      <Button href="/sign-in" variant="outline" className="w-full">Back to sign in</Button>
    </div>
  );
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Email" name="email" type="email" autoComplete="username" required maxLength={254} error={error} />
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send the link"}</Button>
      <A href="/sign-in" className="text-small font-semibold text-deep-green underline-offset-2 hover:underline">Back to sign in</A>
    </form>
  );
}
export function ForgotForm() {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setError(undefined);
    const a = await post("request-password-reset", { email: fields(e).email!.trim(), redirectTo: "/reset-password" });
    if (a.status === 200) return void setSent(true);
    setError(forgotMessage(a)); setPending(false);
  }
  return <ForgotView error={error} pending={pending} sent={sent} onSubmit={onSubmit} />;
}

/** `token` is the one the emailed link carries; `invalid` is true when Better Auth sent the visitor here with ?error=INVALID_TOKEN or with no token. */
export function ResetView({ invalid, error, pending, done, onSubmit }: { invalid?: boolean; error?: string; pending?: boolean; done?: boolean; onSubmit?: (e: FormEvent<HTMLFormElement>) => void }) {
  if (done) return (
    <div className="flex flex-col gap-5">
      <Notice kind="success" title="Password changed">Your other sign-ins have ended. Sign in with the new password.</Notice>
      <Button href="/sign-in" variant="dark" size="lg" className="w-full">Sign in</Button>
    </div>
  );
  if (invalid) return (
    <div className="flex flex-col gap-5">
      <Notice kind="error" title="This link does not work">{INVALID_LINK}</Notice>
      <Button href="/forgot-password" variant="dark" size="lg" className="w-full">Send a new link</Button>
    </div>
  );
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="New password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={MAX_PASSWORD} help={`At least ${MIN_PASSWORD} characters.`} />
      <Input label="Repeat new password" name="repeat" type="password" autoComplete="new-password" required maxLength={MAX_PASSWORD} error={error} />
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Saving" : "Save new password"}</Button>
      <p className="text-small text-muted">Saving ends every other sign-in of this login.</p>
    </form>
  );
}
export function ResetForm({ token }: { token: string }) {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [done, setDone] = useState(false), [invalid, setInvalid] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { password, repeat } = fields(e);
    const problem = passwordProblem(password!, repeat!);
    if (problem) return void setError(problem);
    setPending(true); setError(undefined);
    const a = await post("reset-password", { newPassword: password, token });
    if (a.status === 200) return void setDone(true);
    if (a.status === 400 && a.code === "INVALID_TOKEN") return void setInvalid(true);
    setError(resetMessage(a)); setPending(false);
  }
  return <ResetView invalid={invalid} error={error} pending={pending} done={done} onSubmit={onSubmit} />;
}
