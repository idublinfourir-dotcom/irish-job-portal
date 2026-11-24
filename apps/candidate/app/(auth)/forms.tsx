"use client";
// The forms of the sign-up, sign-in, verify and reset pages. Each posts JSON to the documented Better Auth route (docs/openapi/candidate.yaml,
// /api/auth/candidate/{path}) from the browser, which sends the Origin header the route checks, and shows the words of messages.ts for every answer.
// Every emailed link passes the address of the page it must land on (callbackURL, redirectTo), so it never ends on the auth library's error page.
// The look is in views.tsx; `next` is a return address the server page already checked with ownPath (this file never sees an unchecked one).
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent, type MouseEvent } from "react";
import { afterSignInPath } from "../../lib/paths";
import { NO_ANSWER_BODY, passwordProblem, RESEND_WAIT_SECONDS, resetLinkError, say, type Res } from "./messages";
import { CheckEmailView, ForgotView, LoginView, NotForYouView, ResetView, SignupView, type Answer, type Flash } from "./views";

const BASE = "/api/auth/candidate";
const ACCOUNT = afterSignInPath(); // where a sign-in goes with no return address
const verifiedUrl = (next: string | null) => `/verify?verified=1${next ? `&next=${encodeURIComponent(next)}` : ""}`;

async function post(path: string, body: object): Promise<Res & { url?: string }> {
  try {
    const res = await fetch(`${BASE}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const j = (await res.json().catch(() => null)) as { code?: unknown; url?: unknown } | null;
    return { ok: res.ok, status: res.status, code: typeof j?.code === "string" ? j.code : undefined, url: typeof j?.url === "string" ? j.url : undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}
const fields = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
const GOOGLE = /^https:\/\/accounts\.google\.com\//;
/** Starts Google's own sign-in: the route answers with the address to go to. Only Google's own address is followed. */
async function startGoogle(next: string | null, additionalData?: object): Promise<string | undefined> {
  const r = await post("sign-in/social", { provider: "google", callbackURL: next ?? ACCOUNT, errorCallbackURL: "/login?error=google", ...(additionalData ? { additionalData } : {}) });
  if (r.ok && r.url && GOOGLE.test(r.url)) return void window.location.assign(r.url);
  return say("signin", r).text;
}

function useCountdown(start: number) {
  const [n, set] = useState(start);
  useEffect(() => {
    if (n <= 0) return;
    const t = setTimeout(() => set(n - 1), 1000);
    return () => clearTimeout(t);
  }, [n]);
  return [n, set] as const;
}

/** "Check your email": resend after a wait, change a wrong address (B40), or, with no address yet (a visitor who opened /verify), ask for it first. */
export function CheckEmailFlow({ email: first, next, initialWait = 0, reason, initialFlash }: { email: string | null; next: string | null; initialWait?: number; reason?: string; initialFlash?: Flash }) {
  const [email, setEmail] = useState(first), [wait, setWait] = useCountdown(initialWait);
  const [flash, setFlash] = useState<Flash>(initialFlash), [pending, setPending] = useState(false), [changing, setChanging] = useState(false);
  async function send(to: string) {
    setPending(true); setFlash(undefined);
    const r = await post("send-verification-email", { email: to, callbackURL: verifiedUrl(next) });
    setPending(false);
    if (r.ok) { setEmail(to); setWait(RESEND_WAIT_SECONDS); return void setFlash({ kind: "success", text: "We sent the link. Check your inbox, and your spam folder." }); }
    setFlash({ kind: "error", text: say("resend", r).text });
  }
  async function change(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e), to = f.newEmail!.trim();
    setPending(true); setFlash(undefined);
    // callbackURL: the route sends the link itself; once it passes this on, the link ends on our verified page (until then it ends on the site's home page).
    const r = await post("change-unverified-email", { email, password: f.password, newEmail: to, callbackURL: verifiedUrl(next) });
    setPending(false);
    if (!r.ok) return void setFlash({ kind: "error", text: say("change-email", r).text });
    setEmail(to); setChanging(false); setWait(RESEND_WAIT_SECONDS);
    setFlash({ kind: "success", text: "We sent a new link to the new address. The old link no longer works." });
  }
  return (
    <CheckEmailView
      email={email} reason={reason} wait={wait} flash={flash} changing={changing} pending={pending}
      onResend={() => email && void send(email)} onToggleChange={() => { setChanging(!changing); setFlash(undefined); }} onChange={change}
      onAsk={(e) => { e.preventDefault(); void send(fields(e).email!.trim()); }}
    />
  );
}

export function SignupFlow({ google, employersHref, next }: { google: boolean; employersHref: string | null; next: string | null }) {
  const [stage, setStage] = useState<"form" | "no" | "check">("form"), [answer, setAnswer] = useState<Answer>(null);
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [email, setEmail] = useState("");
  const count = async () => { await post("sign-up/email", NO_ANSWER_BODY); setStage("no"); setPending(false); }; // the answer is the only thing sent: the route adds one to the day's count and keeps nothing else
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (answer === "no") return void (setPending(true), await count());
    if (answer !== "yes") return void setError(say("signup", { ok: false, status: 400, code: "SIGNUP_ANSWERS_REFUSED" }).text);
    const f = fields(e), to = f.email!.trim();
    const problem = passwordProblem(f.password!);
    if (problem) return void setError(problem);
    setPending(true); setError(undefined);
    const r = await post("sign-up/email", { name: f.name!.trim(), email: to, password: f.password, needsPermit: true, over18: f.over18 === "on", acceptsTerms: f.acceptsTerms === "on", callbackURL: verifiedUrl(next) });
    if (r.ok) { setEmail(to); return void setStage("check"); } // 200 whether or not the address already had an account: the page never says which
    setError(say("signup", r).text); setPending(false);
  }
  async function onGoogle(e: MouseEvent<HTMLButtonElement>) {
    if (answer === "no") return void (setPending(true), await count());
    if (answer !== "yes") return void setError(say("signup", { ok: false, status: 400, code: "SIGNUP_ANSWERS_REFUSED" }).text);
    const f = Object.fromEntries(new FormData(e.currentTarget.form!)) as Record<string, string>;
    if (f.over18 !== "on" || f.acceptsTerms !== "on") return void setError(say("signup", { ok: false, status: 400, code: "SIGNUP_ANSWERS_REFUSED" }).text);
    setPending(true); setError(undefined);
    const text = await startGoogle(next, { needsPermit: true, over18: true, acceptsTerms: true });
    if (text) { setError(text); setPending(false); }
  }
  if (stage === "check") return <CheckEmailFlow email={email} next={next} initialWait={RESEND_WAIT_SECONDS} />;
  if (stage === "no") return <NotForYouView employersHref={employersHref} onChange={() => { setAnswer("yes"); setStage("form"); }} />;
  return <SignupView answer={answer} google={google} error={error} pending={pending} employersHref={employersHref} next={next} onAnswer={(a) => { setAnswer(a); setError(undefined); }} onSubmit={onSubmit} onGoogle={onGoogle} />;
}

export function LoginFlow({ google, next, notice }: { google: boolean; next: string | null; notice?: string }) {
  const router = useRouter(), [error, setError] = useState<string>(), [pending, setPending] = useState(false), [unverified, setUnverified] = useState<string>();
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = fields(e), email = f.email!.trim();
    setPending(true); setError(undefined);
    const r = await post("sign-in/email", { email, password: f.password, rememberMe: f.rememberMe === "on" });
    if (r.ok) return void (router.replace(next ?? ACCOUNT), router.refresh()); // refresh: the header reads the new session
    const s = say("signin", r);
    if (s.screen === "check-email") return void setUnverified(email);
    setError(s.text); setPending(false);
  }
  async function onGoogle() {
    setPending(true); setError(undefined);
    const text = await startGoogle(next);
    if (text) { setError(text); setPending(false); }
  }
  if (unverified) return <CheckEmailFlow email={unverified} next={next} reason="Your email is not verified yet." />;
  return <LoginView error={error} notice={notice} pending={pending} google={google} next={next} onSubmit={onSubmit} onGoogle={onGoogle} />;
}

export function ForgotFlow() {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [sent, setSent] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setPending(true); setError(undefined);
    const r = await post("request-password-reset", { email: fields(e).email!.trim(), redirectTo: "/reset" }); // the emailed link ends on our /reset page with the token
    if (r.ok) return void setSent(true);
    setError(say("reset-request", r).text); setPending(false);
  }
  return <ForgotView error={error} pending={pending} sent={sent} onSubmit={onSubmit} />;
}

export function ResetFlow({ token }: { token: string }) {
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false), [done, setDone] = useState(false), [invalid, setInvalid] = useState(false);
  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const { password, repeat } = fields(e);
    const problem = passwordProblem(password!) ?? (password === repeat ? undefined : "The two passwords are not the same.");
    if (problem) return void setError(problem);
    setPending(true); setError(undefined);
    const r = await post("reset-password", { newPassword: password, token });
    if (r.ok) return void setDone(true);
    if (r.code === "INVALID_TOKEN") return void setInvalid(true);
    setError(say("reset", r).text); setPending(false);
  }
  return <ResetView invalid={invalid} linkProblem={resetLinkError("INVALID_TOKEN")} error={error} pending={pending} done={done} onSubmit={onSubmit} />;
}
