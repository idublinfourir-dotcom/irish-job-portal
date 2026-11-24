// Frame E06: what the company waiting for review has so far, and, when staff asked for more, the one note the owner answers with (decisions #197, #219: no letter upload).
// A presentational part: every value arrives as a prop from the page's read (GET /api/portal/verification), so a test renders every state.
import type { ReactNode } from "react";
import { A, Button, Icon, Notice } from "@portal/ui";
import { AnswerForm } from "../(auth)/company-forms";
import { AuthFrame } from "../(auth)/frame";
import { SignOutButton } from "../(auth)/forms";

export type Verification = {
  status: string; emailVerified: boolean; croNumber: string | null; croFound: boolean | null; croName: string | null; croStatus: string | null;
  deteMatch: boolean; reviewOpenedAt: string | null; question: string | null;
};

const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Dublin" });
/** "9 Nov 2026, 10:42" in Irish time; an unreadable value gives null. */
export const when = (iso: string | null): string | null => { const d = iso ? new Date(iso) : null; return d && !Number.isNaN(+d) ? WHEN.format(d) : null; };

type Tone = "done" | "wait" | "later" | "note";
function Row({ tone, title, children }: { tone: Tone; title: string; children?: ReactNode }) {
  const icon = tone === "done" ? "check" : tone === "wait" ? "clock" : tone === "note" ? "info" : "lock";
  return (
    <li data-step-state={tone} className="flex items-center gap-4 border-b border-line py-4 last:border-0">
      <span aria-hidden="true" className={`grid size-11 shrink-0 place-items-center rounded-pill ${tone === "done" || tone === "wait" ? "bg-deep-green text-white" : "bg-white text-deep-green"}`}><Icon name={icon} size={20} /></span>
      <span><span className="block font-semibold">{title}</span>{children && <span className="block text-small text-muted">{children}</span>}</span>
    </li>
  );
}

const ENDED: Record<string, string> = {
  rejected: "Our team did not approve this company account. Contact support if you think that is a mistake.",
  suspended: "This company account is suspended. Open Account status to see why and what you can do.",
  closed: "This company account is closed.",
  banned: "This company account cannot be used.",
};

export function VerificationView({ email, v, isOwner, canDraft, help }: { email: string; v: Verification; isOwner: boolean; canDraft: boolean; help: string | null }) {
  const live = v.status === "verified" || v.status === "verified_restricted";
  const ended = ENDED[v.status];
  const asked = v.status === "needs_info";
  const opened = when(v.reviewOpenedAt);
  return (
    <AuthFrame bare step={live ? 4 : 4} help={help}
      icon={<span aria-hidden="true" className="grid size-12 place-items-center rounded-pill bg-deep-green text-white"><Icon name={live ? "check" : "clock"} size={24} /></span>}
      title={live ? <>Your account is <span className="text-deep-green">live</span></> : ended ? <>This account is <span className="text-deep-green">not active</span></> : <>Your account is <span className="text-deep-green">in review</span></>}
      lead={live ? "Our team approved your company. You can post jobs." : ended ? ended : "We check the CRO record, the DETE match and your email domain. We aim to review within 1 working day, and some take longer."}
      panel={["While you", "wait"]} panelLead="Drafts are kept. Publish a job once your account is approved.">
      {ended ? null : (
        <ul className="rounded-bento bg-sand px-5" aria-label="Verification progress">
          <Row tone={v.emailVerified ? "done" : "wait"} title={v.emailVerified ? "Email verified" : "Email not confirmed"}>{email}</Row>
          {v.croNumber === null
            ? <Row tone="note" title="No CRO number given">Agencies can leave it out. We check the licence by hand.</Row>
            : v.croFound
              ? <Row tone="done" title="CRO record found">{[v.croName, v.croStatus].filter(Boolean).join(" · ")}</Row>
              : <Row tone="note" title="CRO record not found">We did not find CRO number {v.croNumber} in the register data. Our team checks it by hand.</Row>}
          <Row tone={v.deteMatch ? "done" : "note"} title={v.deteMatch ? "In the permit records" : "Not in the permit records"}>
            {v.deteMatch ? "Your company name is in the DETE permit records." : "We did not find your company name in the DETE permit records."}
          </Row>
          <Row tone={live ? "done" : "wait"} title="Admin review">{live ? "Approved" : opened ? `In the queue since ${opened}` : "Waiting for our team"}</Row>
          <Row tone={live ? "done" : "later"} title="Account live">You can post jobs</Row>
        </ul>
      )}
      {asked && (
        <Notice kind="warning" title="We need one more thing">
          {isOwner ? (v.question ? <span data-question className="block">{v.question}</span> : "Our team asked you for more information.") : "Our team asked the account owner for one more thing. Ask them to open this page."}
        </Notice>
      )}
      {asked && isOwner && <AnswerForm />}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
        {live && <Button href="/dashboard" variant="dark">Go to your dashboard</Button>}
        {!live && !ended && canDraft && <A href="/jobs/new" className="inline-flex min-h-11 items-center font-semibold text-deep-green underline-offset-2 hover:underline">Draft a job while you wait</A>}
        {help && <A href={help} className="inline-flex min-h-11 items-center font-semibold text-deep-green underline-offset-2 hover:underline">Contact support</A>}
        <SignOutButton />
      </div>
    </AuthFrame>
  );
}
