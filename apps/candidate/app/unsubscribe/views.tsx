// /unsubscribe (DD29, pattern of frame C26): the page a job alert email's "Stop" links open. It only reads on load; the change happens on Confirm (mail
// scanners open links). It never says whose account it is. Plain functions of their props, so a test renders every state; the request is in flow.tsx.
import { Button, Icon, Notice } from "@portal/ui";
import { AuthFrame, Side } from "../(auth)/auth-frame";
import { BAD_LINK } from "./messages";

export type Alert = { filters: string[]; frequency: "daily" | "weekly"; status: "active" | "paused" | "unsubscribed" };
export type View = "ask" | "done" | "already" | "bad";

const SIDE = { title: <Side a="Your alerts," b="your choice" />, lead: "You can set up a new alert any time from your account." };

export function UnsubscribeView({ view, scope, alert, otherHref, error, problem, pending, onConfirm }: {
  view: View; scope: "one" | "all"; alert: Alert | null; otherHref?: string; error?: string; problem?: string; pending?: boolean; onConfirm?: () => void;
}) {
  const all = scope === "all";
  if (view === "bad") return (
    <AuthFrame icon="bell" title={<>This link <span className="text-deep-green">does not work</span></>} side={SIDE}>
      <Notice kind="error">{problem ?? BAD_LINK}</Notice>
      <Button href="/login" variant="dark" size="lg" className="w-full">Sign in</Button>
    </AuthFrame>
  );
  if (view === "done") return (
    <AuthFrame icon="check" title={all ? <>All job alerts <span className="text-deep-green">stopped</span></> : <>Alert <span className="text-deep-green">stopped</span></>} side={SIDE}>
      <Notice kind="success">{all ? "We will not send you any more job alert emails." : "We will not send you emails for this alert. Your other alerts are not changed."}</Notice>
      <Button href="/jobs" variant="dark" size="lg" className="w-full">Find jobs</Button>
    </AuthFrame>
  );
  if (view === "already") return (
    <AuthFrame icon="check" title={<>Already <span className="text-deep-green">stopped</span></>} side={SIDE}>
      <Notice kind="info">This alert was already stopped, so there is nothing more to do. We are not sending emails for it.</Notice>
      <Button href="/jobs" variant="dark" size="lg" className="w-full">Find jobs</Button>
    </AuthFrame>
  );
  return (
    <AuthFrame icon="bell" title={all ? <>Stop <span className="text-deep-green">all</span> job alerts?</> : <>Stop this <span className="text-deep-green">job alert</span>?</>}
      lead={all ? "This stops every job alert email on the account this link was made for." : "This stops the emails for the alert below. Your other alerts are not changed."} side={SIDE}>
      {alert && (
        <dl className="flex flex-col gap-3 rounded-card bg-sand p-5 text-small">
          <div><dt className="font-semibold">{all ? "The alert in the email" : "What it looks for"}</dt><dd className="text-muted">{alert.filters.length ? alert.filters.join(" · ") : "Every job"}</dd></div>
          <div><dt className="font-semibold">How often</dt><dd className="text-muted">{alert.frequency === "daily" ? "Every day" : "Every week"}</dd></div>
          <div><dt className="font-semibold">Now</dt><dd className="text-muted">{alert.status === "paused" ? "Paused" : "Sending emails"}</dd></div>
        </dl>
      )}
      {error && <Notice kind="error">{error}</Notice>}
      <Button variant="dark" size="lg" disabled={pending} onClick={onConfirm} className="w-full">{pending ? "Stopping" : all ? "Confirm: stop all alerts" : "Confirm: stop this alert"}</Button>
      {otherHref && <a href={otherHref} className="inline-flex items-center gap-1 text-small font-semibold text-deep-green underline underline-offset-2">{all ? "Stop only this alert instead" : "Stop all job alerts instead"}<Icon name="arrow" size={14} /></a>}
    </AuthFrame>
  );
}
