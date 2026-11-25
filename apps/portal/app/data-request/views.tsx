// /data-request (DD30, employer wording of frame C26): the page a data request email opens for an employer or agency login. It only reads on load (what the
// request is, when the link ends); the change happens on Confirm. It never says whose login it is. Plain functions of their props; the request is in flow.tsx.
import { Button, Icon, Notice } from "@portal/ui";
import { AuthFrame } from "../(auth)/frame";
import { endsAt, INVALID_LINK } from "./messages";

export type Purpose = "export" | "erase";
export type Links = { candidates?: string | null; help?: string | null }; // the frame's links, read by the page (a client file may not import the data layer)
export type View = "ask" | "exported" | "erased" | "invalid" | "bad";
const SIDE = { panel: ["Your data,", "your say"] as [string, string], panelLead: "Only you, with the link from your email, can confirm this. Nothing happens until you press Confirm." };
const badge = (name: "shield" | "check") => <span aria-hidden="true" className="grid size-[52px] place-items-center rounded-pill bg-deep-green text-white"><Icon name={name} size={24} /></span>;

export function DataRequestView({ view, purpose, expiresAt, error, problem, pending, onConfirm, links }: {
  view: View; purpose: Purpose; expiresAt?: string; error?: string; problem?: string; pending?: boolean; onConfirm?: () => void; links?: Links;
}) {
  const frame = { ...SIDE, candidates: links?.candidates ?? null, help: links?.help ?? null };
  if (view === "bad" || view === "invalid") return (
    <AuthFrame icon={badge("shield")} title={view === "bad" ? <>This link <span className="text-deep-green">does not work</span></> : <>This link is <span className="text-deep-green">used or ended</span></>} {...frame}>
      <Notice kind="error">{problem ?? INVALID_LINK}</Notice>
    </AuthFrame>
  );
  if (view === "exported") return (
    <AuthFrame icon={badge("check")} title={<>Your data file is <span className="text-deep-green">downloaded</span></>} {...frame}>
      <Notice kind="success">The file is in your downloads. This link works once, so it will not work again. Keep the file somewhere safe: it holds personal data, and we cannot send it again from this link.</Notice>
      <Button href="/" variant="dark" size="lg" className="w-full">Back to the site</Button>
    </AuthFrame>
  );
  if (view === "erased") return (
    <AuthFrame icon={badge("check")} title={<>Deletion <span className="text-deep-green">confirmed</span></>} {...frame}>
      <Notice kind="success">Thank you. Our team will now delete your login and the data in it. A second member of our team has to approve it first, so it is not instant. You do not need to do anything else.</Notice>
      <Button href="/" variant="dark" size="lg" className="w-full">Back to the site</Button>
    </AuthFrame>
  );
  const ends = expiresAt ? endsAt(expiresAt) : null, erase = purpose === "erase";
  return (
    <AuthFrame icon={badge("shield")} title={erase ? <>Delete your <span className="text-deep-green">login</span>?</> : <>Get a copy of <span className="text-deep-green">your data</span></>}
      lead={erase ? "You, or someone with access to your email, asked us to delete your login and the data in it." : "You asked us for a copy of the data in your login. Confirm to download it now, as a file."} {...frame}>
      <ul className="flex flex-col gap-2 rounded-card bg-sand p-5 text-small">
        <li><strong>What happens:</strong> {erase ? "Pressing Confirm tells our team you want your login deleted. Our team checks it, and a second member approves it, before anything is deleted. Deleting cannot be undone." : "Pressing Confirm downloads the file to this device. We do not email it and our staff do not receive it."}</li>
        <li><strong>This link works once</strong>{ends ? <>, and ends on {ends}.</> : "."}</li>
        <li>If you did not ask for this, close the page. Nothing will happen.</li>
      </ul>
      {error && <Notice kind="error">{error}</Notice>}
      <Button variant="dark" size="lg" disabled={pending} onClick={onConfirm} className="w-full">{pending ? "Working" : erase ? "Confirm: delete my login" : "Confirm: download my data"}</Button>
    </AuthFrame>
  );
}
