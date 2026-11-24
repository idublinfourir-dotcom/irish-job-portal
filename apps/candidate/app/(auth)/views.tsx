// The look of the candidate sign-up, sign-in, verify and reset screens (frames NS3, M06, C24, C26, C27). Plain functions of their props, so a test renders
// every state to HTML (react-dom/server); the state and the requests live in forms.tsx. Nothing here reads a database.
import type { FormEvent, MouseEvent, ReactNode } from "react";
import { A, Button, Checkbox, CriticalSkillsBadge, Icon, Input, Notice, SponsorBadge } from "@portal/ui";
import { Dot, Hl, PhotoBlock } from "../jobs/parts";
import { AuthFrame, Side } from "./auth-frame";
import { PASSWORD_MAX, PASSWORD_MIN } from "./messages";

type Submit = (e: FormEvent<HTMLFormElement>) => void;
const linkClass = "font-semibold text-deep-green underline-offset-2 hover:underline";
export const ELIGIBILITY_HREF = "/eligibility-checker"; // the checker page (another slice); the home page and the footer link to the same address

/** The "continue with Google" button, only when the site has Google set up (Q24: off until the Google client exists, so `google` is false for now). */
type Click = (e: MouseEvent<HTMLButtonElement>) => void;
export function GoogleButton({ onClick, pending }: { onClick?: Click; pending?: boolean }) {
  return (
    <>
      <Button type="button" variant="outline" size="lg" className="w-full" onClick={onClick} disabled={pending}>
        <span aria-hidden="true" className="grid size-6 place-items-center rounded-pill bg-lilac text-caption font-semibold">G</span>
        Continue with Google
      </Button>
      <p className="flex items-center gap-3 text-caption text-muted before:h-px before:flex-1 before:bg-line after:h-px after:flex-1 after:bg-line">or use your email</p>
    </>
  );
}

// ===== sign-up (NS3 on a desktop, M06 on a phone) =====
export type Answer = "yes" | "no" | null;

function Pick({ value, checked, onChange, children }: { value: string; checked: boolean; onChange?: () => void; children: ReactNode }) {
  return (
    <label className="relative flex min-h-12 flex-1 cursor-pointer items-center gap-3 rounded-pill bg-white px-5 text-ui has-checked:bg-deep-green has-checked:text-white has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ink">
      <input type="radio" name="needsPermit" value={value} checked={checked} onChange={onChange} required className="size-5 accent-ink has-checked:accent-white" />
      {children}
    </label>
  );
}

export function SignupView({ answer, google, error, pending, employersHref, next, onAnswer, onSubmit, onGoogle }: {
  answer: Answer; google?: boolean; error?: string; pending?: boolean; employersHref: string | null; next: string | null; onAnswer?: (a: "yes" | "no") => void; onSubmit?: Submit; onGoogle?: Click;
}) {
  const yes = answer === "yes";
  return (
    <div className="mx-auto grid max-w-page gap-5 px-5 py-6 sm:px-8 lg:grid-cols-2 lg:py-8">
      <form onSubmit={onSubmit} aria-busy={pending || undefined} className="flex flex-col gap-5 lg:rounded-bento lg:bg-sand lg:p-12">
        <div className="flex flex-col gap-3">
          <h1 className="text-[1.875rem] leading-[1.15] lg:text-[3rem] lg:leading-[1.2]">Create your <span className="text-deep-green lg:inline-block lg:rounded-[0.28em] lg:bg-deep-green lg:px-[0.22em] lg:pb-[0.08em] lg:text-white">free account</span> <span className="hidden lg:inline"><Dot /></span></h1>
          <p className="text-muted">See every job, save jobs, set alerts and track applications.</p>
        </div>
        <fieldset className="flex flex-col gap-3 rounded-bento bg-sand p-5 lg:bg-lilac lg:p-6">
          <legend className="sr-only">Your permit</legend>
          <p className="font-semibold" id="permit-q">Do you need, or will you soon need, an employment permit to work in Ireland?</p>
          <div role="radiogroup" aria-labelledby="permit-q" className="flex flex-col gap-2 sm:flex-row">
            <Pick value="yes" checked={yes} onChange={() => onAnswer?.("yes")}>Yes</Pick>
            <Pick value="no" checked={answer === "no"} onChange={() => onAnswer?.("no")}>No</Pick>
          </div>
          <A href={ELIGIBILITY_HREF} className="inline-flex items-center gap-2 text-small font-medium text-deep-green lg:text-ink"><Icon name="help" size={16} />Not sure? See who needs a permit</A>
        </fieldset>
        {google && <GoogleButton onClick={onGoogle} pending={pending} />}
        <Input label="Your name" name="name" autoComplete="name" required={yes} maxLength={100} />
        <Input label="Email" name="email" type="email" icon="mail" autoComplete="email" placeholder="you@example.com" required={yes} maxLength={254} />
        <Input label="Password" name="password" type="password" icon="lock" autoComplete="new-password" required={yes} minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} help={`At least ${PASSWORD_MIN} characters.`} />
        <div className="flex flex-col">
          <Checkbox label="I am 18 or over." name="over18" required={yes} />
          <label className="flex min-h-11 cursor-pointer items-center gap-3">
            <input type="checkbox" name="acceptsTerms" required={yes} className="size-5 shrink-0 accent-deep-green" />
            <span>I agree to the <A href="/terms" className={linkClass}>Terms</A> and have read the <A href="/privacy" className={linkClass}>Privacy notice</A>.</span>
          </label>
        </div>
        {error && <Notice kind="error">{error}</Notice>}
        <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Creating" : "Create account"}</Button>
        <p className="text-small text-muted">
          Already have an account? <A href={next ? `/login?next=${encodeURIComponent(next)}` : "/login"} className={linkClass}>Sign in</A>
          {employersHref && <> · Hiring? <A href={employersHref} className={linkClass}>Employer portal</A></>}
        </p>
        <p className="rounded-bento bg-peach p-5 text-small">
          <strong className="mb-1 block text-ui">If you answer &quot;No&quot;</strong>
          This site is only for people who need a permit. EU, EEA, Swiss and UK citizens and Stamp 4 holders do not need one. Students on Stamp 2 and graduates on Stamp 1G can sign up.
        </p>
      </form>
      <div className="hidden flex-col gap-4 lg:flex" data-aside>
        <div className="relative flex min-h-[560px] flex-1 flex-col justify-end p-5">
          <PhotoBlock className="absolute inset-0" />
          <div className="relative flex flex-col gap-3 rounded-bento bg-white p-8">
            <p className="font-heading text-[2.5rem] font-semibold leading-[1.25] tracking-tight">See <Hl c="peach">every job</Hl> a permit can <Hl c="green">cover</Hl></p>
            <p className="text-small text-muted">Every listing passed the permit rules, or the employer confirmed sponsorship.</p>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-bento bg-ink p-7 text-white">
            <p className="font-heading text-lg font-semibold">Free for candidates</p>
            <p className="text-small text-white/75">The job board is always free. Our permit services are paid by the employer or agency, never by you.</p>
          </div>
          <div className="flex flex-col items-start gap-2 rounded-bento bg-ink p-7 text-white">
            <p className="font-heading text-lg font-semibold">Two badges, two sources</p>
            <SponsorBadge />
            <CriticalSkillsBadge />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Frame C24: the "No" answer. Nothing was kept except one day count. */
export function NotForYouView({ employersHref, onChange }: { employersHref: string | null; onChange?: () => void }) {
  const row = "flex min-h-12 items-center justify-between rounded-pill px-5 py-3 font-medium no-underline hover:bg-sand";
  return (
    <AuthFrame icon="info" title="This site is only for people who need a permit" lead="You answered that you do not need an employment permit. EU, EEA, Swiss and UK citizens, and Stamp 4 holders, can work in Ireland without one, so the jobs here are not aimed at you." side={{ title: <Side a="Not for everyone," b="on purpose" />, lead: "We list only jobs where an Irish employment permit is realistic, for people who need one." }}>
      <div className="flex flex-col items-start gap-3 rounded-bento bg-sand p-6">
        <h2 className="text-ui">Students and graduates</h2>
        <p className="text-small text-muted">On Stamp 2 or Stamp 1G? You will need a permit for your next full-time job, so you can sign up.</p>
        <Button type="button" variant="chip" size="md" onClick={onChange} className="text-deep-green!">Change my answer</Button>
      </div>
      <nav aria-label="Other places" className="flex flex-col">
        <A href={ELIGIBILITY_HREF} className={row}>Not sure? See who needs a permit <Icon name="arrow" size={18} /></A>
        <A href="/jobs" className={row}>Browse jobs without an account <Icon name="arrow" size={18} /></A>
        {employersHref && <A href={employersHref} className={row}>I am an employer or agency <Icon name="arrow" size={18} /></A>}
      </nav>
    </AuthFrame>
  );
}

// ===== check your email (C27) =====
export type Flash = { kind: "success" | "error"; text: string } | undefined;
export const CHECK_SIDE = { title: <Side a="One step" b="left" />, lead: "We verify every email so alerts and employer requests reach the right person." };

export function CheckEmailView({ email, reason, wait, flash, changing, pending, onResend, onToggleChange, onChange, onAsk }: {
  email: string | null; reason?: string; wait: number; flash?: Flash; changing?: boolean; pending?: boolean; onResend?: () => void; onToggleChange?: () => void; onChange?: Submit; onAsk?: Submit;
}) {
  const note = flash && <Notice kind={flash.kind}>{flash.text}</Notice>;
  if (!email)
    return (
      <AuthFrame icon="mail" title={<>Get a new <span className="text-deep-green">link</span></>} lead="Enter the email address you signed up with. If it has an account that is not verified yet, we send a new link." side={CHECK_SIDE}>
        <form onSubmit={onAsk} aria-busy={pending || undefined} className="flex flex-col gap-5">
          <Input label="Email" name="email" type="email" icon="mail" autoComplete="email" required maxLength={254} />
          {note}
          <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send the link"}</Button>
          <p className="text-small text-muted">Already verified? <A href="/login" className={linkClass}>Sign in</A></p>
        </form>
      </AuthFrame>
    );
  return (
    <AuthFrame icon="mail" title={<>Check your <span className="text-deep-green">email</span></>} lead={<>{reason && <>{reason} </>}We sent a link to <strong className="font-semibold text-ink [overflow-wrap:anywhere]">{email}</strong>. Open it to verify your address and finish sign-up.</>} side={CHECK_SIDE}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <Button type="button" variant="chip" size="md" onClick={onResend} disabled={wait > 0 || pending} className="text-deep-green!">{pending ? "Sending" : "Resend email"}</Button>
        {wait > 0 && <p className="text-small text-muted" role="status">You can resend in {wait} {wait === 1 ? "second" : "seconds"}.</p>}
      </div>
      {note}
      {changing ? (
        <form onSubmit={onChange} aria-busy={pending || undefined} className="flex flex-col gap-4 border-t border-line pt-5">
          <h2 className="text-ui">Change the address</h2>
          <Input label="New email" name="newEmail" type="email" autoComplete="email" required maxLength={254} />
          <Input label="Your password" name="password" type="password" autoComplete="current-password" required maxLength={PASSWORD_MAX} help="The one you chose when you signed up. It proves the account is yours." />
          <div className="flex flex-wrap gap-3">
            <Button type="submit" variant="dark" size="md" disabled={pending}>Send to the new address</Button>
            <Button type="button" variant="outline" size="md" onClick={onToggleChange}>Cancel</Button>
          </div>
        </form>
      ) : (
        <p className="text-small text-muted">Wrong address? <button type="button" onClick={onToggleChange} className={`${linkClass} cursor-pointer`}>Change it</button></p>
      )}
    </AuthFrame>
  );
}

// ===== sign in (C26) =====
export function LoginView({ error, notice, pending, google, next, onSubmit, onGoogle }: { error?: string; notice?: string; pending?: boolean; google?: boolean; next: string | null; onSubmit?: Submit; onGoogle?: Click }) {
  return (
    <AuthFrame title={<>Welcome <span className="text-deep-green">back</span></>} lead="Sign in to see every job and your tracker." side={{ title: <Side a="Your jobs, alerts and" b="tracker" />, lead: "Pick up where you left off. Closed jobs are flagged for you." }}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
        {notice && <Notice kind="info">{notice}</Notice>}
        {google && <GoogleButton onClick={onGoogle} pending={pending} />}
        <Input label="Email" name="email" type="email" icon="mail" autoComplete="username" placeholder="you@example.com" required maxLength={254} />
        <Input label="Password" name="password" type="password" icon="lock" autoComplete="current-password" placeholder="Your password" required maxLength={PASSWORD_MAX} error={error} />
        <div className="flex flex-wrap items-center justify-between gap-x-4">
          <Checkbox label="Keep me signed in" name="rememberMe" defaultChecked />
          <A href="/reset" className="text-small font-semibold text-deep-green underline-offset-2 hover:underline">Forgot password?</A>
        </div>
        <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Signing in" : "Sign in"}</Button>
        <p className="text-small text-muted">New here? <A href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"} className={linkClass}>Create a free account</A></p>
      </form>
    </AuthFrame>
  );
}

// ===== reset password (C27 "same layout") =====
export const RESET_SIDE = { title: <Side a="Back in your" b="account" />, lead: "Choose a new password. Every other sign-in of your account ends when you save it." };

export function ForgotView({ error, pending, sent, onSubmit }: { error?: string; pending?: boolean; sent?: boolean; onSubmit?: Submit }) {
  if (sent)
    return (
      <AuthFrame icon="mail" title={<>Check your <span className="text-deep-green">email</span></>} lead="If that address has an account, a link to choose a new password is on its way. It works for 1 hour and only once." side={RESET_SIDE}>
        <Button href="/login" variant="outline" size="lg" className="w-full">Back to sign in</Button>
      </AuthFrame>
    );
  return (
    <AuthFrame title={<>Reset your <span className="text-deep-green">password</span></>} lead="Enter your email. If it has an account, we send a link to choose a new password." side={RESET_SIDE}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
        <Input label="Email" name="email" type="email" autoComplete="username" required maxLength={254} error={error} />
        <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Sending" : "Send the link"}</Button>
        <A href="/login" className={`text-small ${linkClass}`}>Back to sign in</A>
      </form>
    </AuthFrame>
  );
}

export function ResetView({ invalid, linkProblem, error, pending, done, onSubmit }: { invalid?: boolean; linkProblem?: string; error?: string; pending?: boolean; done?: boolean; onSubmit?: Submit }) {
  if (done)
    return (
      <AuthFrame icon="check" title={<>Password <span className="text-deep-green">changed</span></>} lead="Your other sign-ins have ended. Sign in with the new password." side={RESET_SIDE}>
        <Button href="/login" variant="dark" size="lg" className="w-full">Sign in</Button>
      </AuthFrame>
    );
  if (invalid)
    return (
      <AuthFrame icon="warning" title={<>This link does <span className="text-deep-green">not work</span></>} side={RESET_SIDE}>
        <Notice kind="error">{linkProblem ?? "This link has expired or was already used. Ask for a new one."}</Notice>
        <Button href="/reset" variant="dark" size="lg" className="w-full">Send a new link</Button>
      </AuthFrame>
    );
  return (
    <AuthFrame title={<>Choose a new <span className="text-deep-green">password</span></>} side={RESET_SIDE}>
      <form onSubmit={onSubmit} className="flex flex-col gap-5" aria-busy={pending || undefined}>
        <Input label="New password" name="password" type="password" icon="lock" autoComplete="new-password" required minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} help={`At least ${PASSWORD_MIN} characters.`} />
        <Input label="Repeat new password" name="repeat" type="password" icon="lock" autoComplete="new-password" required maxLength={PASSWORD_MAX} error={error} />
        <Button type="submit" variant="dark" size="lg" disabled={pending} className="w-full">{pending ? "Saving" : "Save new password"}</Button>
      </form>
    </AuthFrame>
  );
}

// ===== verify landing =====
/** After the emailed link: the email is verified (a link used a second time lands here too), or the link did not work. */
export function VerifiedView({ signedIn, loginHref, continueHref }: { signedIn: boolean; loginHref: string; continueHref: string }) {
  return (
    <AuthFrame icon="check" title={<>Email <span className="text-deep-green">verified</span></>} lead="Your address is confirmed, so alerts and permit requests reach you." side={{ title: <Side a="You are" b="in" />, lead: "See every job, save the ones you like, set alerts and track your applications." }}>
      <Button href={signedIn ? continueHref : loginHref} variant="dark" size="lg" className="w-full">{signedIn ? "Continue" : "Sign in"}</Button>
    </AuthFrame>
  );
}
