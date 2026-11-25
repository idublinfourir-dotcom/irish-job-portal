// /data-request (DD30, pattern of frame C26): the page a data request email opens. It only reads on load (what the request is, when the link ends); the
// change happens on Confirm. It never says whose account it is. Plain functions of their props, so a test renders every state; the request is in flow.tsx.
import { Button, Notice } from "@portal/ui";
import { AuthFrame, Side } from "../(auth)/auth-frame";
import { endsAt, INVALID_LINK } from "./messages";

export type Purpose = "export" | "erase";
export type View = "ask" | "exported" | "erased" | "invalid" | "bad";
const SIDE = { title: <Side a="Your data," b="your say" />, lead: "Only you, with the link from your email, can confirm this. Nothing happens until you press Confirm." };

export function DataRequestView({ view, purpose, expiresAt, error, problem, pending, onConfirm }: {
  view: View; purpose: Purpose; expiresAt?: string; error?: string; problem?: string; pending?: boolean; onConfirm?: () => void;
}) {
  if (view === "bad" || view === "invalid") return (
    <AuthFrame icon="shield" title={view === "bad" ? <>This link <span className="text-deep-green">does not work</span></> : <>This link is <span className="text-deep-green">used or ended</span></>} side={SIDE}>
      <Notice kind="error">{problem ?? INVALID_LINK}</Notice>
      <Button href="/help" variant="dark" size="lg" className="w-full">Contact us</Button>
    </AuthFrame>
  );
  if (view === "exported") return (
    <AuthFrame icon="check" title={<>Your data file is <span className="text-deep-green">downloaded</span></>} side={SIDE}>
      <Notice kind="success">The file is in your downloads. This link works once, so it will not work again. Keep the file somewhere safe: it holds your personal data, and we cannot send it again from this link.</Notice>
      <Button href="/" variant="dark" size="lg" className="w-full">Back to the site</Button>
    </AuthFrame>
  );
  if (view === "erased") return (
    <AuthFrame icon="check" title={<>Deletion <span className="text-deep-green">confirmed</span></>} side={SIDE}>
      <Notice kind="success">Thank you. Our team will now delete your account and the data in it. A second member of our team has to approve it first, so it is not instant. You do not need to do anything else.</Notice>
      <Button href="/" variant="dark" size="lg" className="w-full">Back to the site</Button>
    </AuthFrame>
  );
  const ends = expiresAt ? endsAt(expiresAt) : null, erase = purpose === "erase";
  return (
    <AuthFrame icon="shield" title={erase ? <>Delete your <span className="text-deep-green">account</span>?</> : <>Get a copy of <span className="text-deep-green">your data</span></>}
      lead={erase ? "You, or someone with access to your email, asked us to delete your account and the data in it." : "You asked us for a copy of the data in your account. Confirm to download it now, as a file."} side={SIDE}>
      <ul className="flex flex-col gap-2 rounded-card bg-sand p-5 text-small">
        <li><strong>What happens:</strong> {erase ? "Pressing Confirm tells our team you want your account deleted. Our team checks it, and a second member approves it, before anything is deleted. Deleting cannot be undone." : "Pressing Confirm downloads the file to this device. We do not email it and our staff do not receive it."}</li>
        <li><strong>This link works once</strong>{ends ? <>, and ends on {ends}.</> : "."}</li>
        <li>If you did not ask for this, close the page. Nothing will happen.</li>
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      <Button variant="dark" size="lg" disabled={pending} onClick={onConfirm} className="w-full">{pending ? "Working" : erase ? "Confirm: delete my account" : "Confirm: download my data"}</Button>
    </AuthFrame>
  );
}
