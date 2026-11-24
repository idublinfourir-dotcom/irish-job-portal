"use client";
// The employer account forms: sign-up, sign-in, forgot password, reset password, resend, sign out. Each posts JSON to the documented Better Auth route of the portal pool
// (docs/openapi/portal.yaml, /api/auth/portal/{path}) from the browser, which sends the Origin header the route checks, and shows the words of messages.ts for every answer.
// The View parts take their state as props, so a test renders every state. `next` is a path the server component already checked (never read from the address here).
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { A, Button, Checkbox, Input, Notice } from "@portal/ui";
import { api, AUTH, fields, verifyCallback } from "./api";
import { linkMessage, MAX_PASSWORD, MIN_PASSWORD, NAME_MAX, passwordProblem, resetMessage, signInMessage, signUpMessage, INVALID_LINK } from "./messages";

type Submit = (e: FormEvent<HTMLFormElement>) => void;
type Kind = "employer" | "agency";

/** Where a new account goes after its email is confirmed and it signs in: the claim step for an employer, the agency step for an agency, or the checked return address. */
export const afterVerify = (kind: Kind, next: string | null) => next ?? (kind === "agency" ? "/sign-up/agency" : "/sign-up/claim");

export function SignUpView({ error, pending, termsHref, onSubmit }: { error?: string; pending?: boolean; termsHref?: string; onSubmit?: Submit }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Your name" name="name" autoComplete="name" required maxLength={NAME_MAX} />
      <Input label="Work email" name="email" type="email" autoComplete="username" required maxLength={254} />
      <Input label="Password" name="password" type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} maxLength={MAX_PASSWORD} help={`At least ${MIN_PASSWORD} characters.`} />
      <div>
        <Checkbox name="acceptsTerms" required label="I accept the terms for employers and agencies." />
        {termsHref && <A href={termsHref} className="ml-8 text-small font-semibold text-deep-green underline underline-offset-2">Read the terms</A>}
      </div>
      {error && <Notice kind="error">{error}</Notice>}
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Creating" : "Create account"}</Button>
    </form>
  );
}

/** The screen after sign-up (frame C27 in employer wording): the link was sent, how long it works, resend. */
export function CheckEmailView({ email, resent, error, pending, onResend }: { email: string; resent?: boolean; error?: string; pending?: boolean; onResend?: () => void }) {
  return (
    <div className="flex flex-col gap-5">
      <Notice kind="success" title="Check your email">We sent a link to <strong>{email}</strong>. Open it to confirm your address, then sign in to carry on. The link works for 1 hour.</Notice>
      {resent && <Notice kind="info">We sent the link again. If it does not come, check your spam folder.</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <Button variant="outline" size="lg" disabled={pending} onClick={onResend} className="w-full">{pending ? "Sending" : "Send the link again"}</Button>
      <p className="text-small text-muted">Wrong address? <A href="/sign-up" className="font-semibold text-deep-green underline underline-offset-2">Sign up again</A> with the right one.</p>
    </div>
  );
}

export function SignUpForm({ kind, next, termsHref }: { kind: Kind; next: string | null; termsHref?: string }) {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState<string>(), [resent, setResent] = useState(false);
  const callbackURL = verifyCallback(afterVerify(kind, next));
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e);
    const problem = passwordProblem(f.password!);
    if (problem) return void setError(problem);
    setPending(true); setError(undefined);
    const a = await api(`${AUTH}/sign-up/email`, { method: "POST", body: { name: f.name!.trim(), email: f.email!.trim(), password: f.password, acceptsTerms: f.acceptsTerms === "on", callbackURL } });
    if (a.status === 200) return void setSent(f.email!.trim());
    setError(signUpMessage(a)); setPending(false);
  }
  async function resend() {
    setPending(true); setError(undefined);
    const a = await api(`${AUTH}/send-verification-email`, { method: "POST", body: { email: sent, callbackURL } });
    setPending(false);
    if (a.status === 200) return void setResent(true);
    setError(linkMessage(a));
  }
  return sent ? <CheckEmailView email={sent} resent={resent} error={error} pending={pending} onResend={resend} /> : <SignUpView error={error} pending={pending} termsHref={termsHref} onSubmit={onSubmit} />;
}

export function SignInView({ error, notVerified, resent, pending, notice, onSubmit, onResend }: { error?: string; notVerified?: boolean; resent?: boolean; pending?: boolean; notice?: string; onSubmit?: Submit; onResend?: () => void }) {
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      {notice && <Notice kind="success">{notice}</Notice>}
      <Input label="Email" name="email" type="email" autoComplete="username" required maxLength={254} />
      <Input label="Password" name="password" type="password" autoComplete="current-password" required maxLength={MAX_PASSWORD} error={error} />
      {notVerified && (resent
        ? <Notice kind="info">We sent the link again. If it does not come, check your spam folder.</Notice>
        : <Button variant="outline" disabled={pending} onClick={onResend}>Send the confirmation link again</Button>)}
      <A href="/forgot-password" className="self-end text-small font-semibold text-deep-green underline-offset-2 hover:underline">Forgot password?</A>
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Signing in" : "Sign in"}</Button>
      <p className="text-small text-muted">New here? <A href="/sign-up" className="font-semibold text-deep-green underline underline-offset-2">Create an employer account</A></p>
    </form>
  );
}
export function SignInForm({ next, notice }: { next: string | null; notice?: string }) {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false), [notVerified, setNotVerified] = useState(false), [resent, setResent] = useState(false);
  const [email, setEmail] = useState("");
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e);
    setEmail(f.email!.trim()); setPending(true); setError(undefined); setNotVerified(false); setResent(false);
    const a = await api(`${AUTH}/sign-in/email`, { method: "POST", body: { email: f.email!.trim(), password: f.password } });
    if (a.status === 200) return void (router.replace(next ?? "/"), router.refresh()); // "/" sends each login where it belongs; refresh: the layout reads the new session
    setNotVerified(a.status === 403 && a.code === "EMAIL_NOT_VERIFIED");
    setError(signInMessage(a)); setPending(false);
  }
  async function resend() {
    setPending(true);
    const a = await api(`${AUTH}/send-verification-email`, { method: "POST", body: { email, callbackURL: verifyCallback(next) } });
    setPending(false);
    if (a.status === 200) return void setResent(true);
    setError(linkMessage(a));
  }
  return <SignInView error={error} notVerified={notVerified} resent={resent} pending={pending} notice={notice} onSubmit={onSubmit} onResend={resend} />;
}

export function ForgotView({ error, pending, sent, onSubmit }: { error?: string; pending?: boolean; sent?: boolean; onSubmit?: Submit }) {
  if (sent) return (
    <div className="flex flex-col gap-5">
      <Notice kind="success" title="Check your email">If that address has an employer login, a link is on its way. It works for 1 hour and only once.</Notice>
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
    const a = await api(`${AUTH}/request-password-reset`, { method: "POST", body: { email: fields(e).email!.trim(), redirectTo: "/reset-password" } });
    if (a.status === 200) return void setSent(true);
    setError(linkMessage(a)); setPending(false);
  }
  return <ForgotView error={error} pending={pending} sent={sent} onSubmit={onSubmit} />;
}

/** `invalid` is true when Better Auth sent the visitor here with ?error=INVALID_TOKEN or with no token. */
export function ResetView({ invalid, error, pending, done, onSubmit }: { invalid?: boolean; error?: string; pending?: boolean; done?: boolean; onSubmit?: Submit }) {
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
    const a = await api(`${AUTH}/reset-password`, { method: "POST", body: { newPassword: password, token } });
    if (a.status === 200) return void setDone(true);
    if (a.status === 400 && a.code === "INVALID_TOKEN") return void setInvalid(true);
    setError(resetMessage(a)); setPending(false);
  }
  return <ResetView invalid={invalid} error={error} pending={pending} done={done} onSubmit={onSubmit} />;
}

/** The verify-email page's second chance: a link that ended or was used. Asks for the address and sends a new link. */
export function ResendView({ error, pending, sent, onSubmit }: { error?: string; pending?: boolean; sent?: boolean; onSubmit?: Submit }) {
  if (sent) return <Notice kind="success" title="Check your email">If that address has an account that is not confirmed yet, a new link is on its way. It works for 1 hour.</Notice>;
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
      <Input label="Email" name="email" type="email" autoComplete="username" required maxLength={254} error={error} />
      <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send a new link"}</Button>
    </form>
  );
}
export function ResendForm({ next }: { next: string | null }) {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setError(undefined);
    const a = await api(`${AUTH}/send-verification-email`, { method: "POST", body: { email: fields(e).email!.trim(), callbackURL: verifyCallback(next) } });
    if (a.status === 200) return void setSent(true);
    setError(linkMessage(a)); setPending(false);
  }
  return <ResendView error={error} pending={pending} sent={sent} onSubmit={onSubmit} />;
}

/** "Not you? Sign out": ends this login's session and goes to the sign-in page. */
export function SignOutButton({ className }: { className?: string }) {
  const router = useRouter(), [pending, setPending] = useState(false);
  return (
    <button type="button" disabled={pending} className={className ?? "inline-flex min-h-11 items-center font-semibold text-deep-green underline underline-offset-2"}
      onClick={async () => { setPending(true); await api(`${AUTH}/sign-out`, { method: "POST", body: {} }); router.replace("/sign-in"); router.refresh(); }}>
      Sign out
    </button>
  );
}
