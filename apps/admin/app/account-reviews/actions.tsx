"use client";
// The buttons of the account review detail card: claim, release, then Approve (with "Add the email domain"), Ask for more (with the question the company is emailed)
// and Reject (with a reason code). Each decision asks to confirm first. They post to POST /api/account-review (docs/openapi/admin.yaml), which checks the role,
// the claim and the Origin again, and writes the audit row. ActionsView takes its state as props so a test renders every state.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Checkbox, Dialog, Notice, Select, Textarea } from "@portal/ui";
import { errorWords } from "../_queue/messages";
import { postJson } from "../_queue/post";
import { REJECT_REASONS } from "./text";

export type Ask = null | "approve" | "ask_more" | "reject";
export type Props = { itemId: string; status: string; mine: boolean; emailDomain: string | null; canAddDomain: boolean; companyName: string; listHref: string };
export type ViewState = { ask: Ask; pending: boolean; error?: string; addDomain: boolean; question: string; reason: string };
export type Handlers = { onClaim: () => void; onRelease: () => void; onAsk: (a: Ask) => void; onConfirm: () => void; onChange: (patch: Partial<ViewState>) => void };

export const QUESTION_MAX = 1000;

const CONFIRM: Record<Exclude<Ask, null>, { title: string; button: string }> = {
  approve: { title: "Approve this company?", button: "Approve" },
  ask_more: { title: "Ask the company for more information?", button: "Send the question" },
  reject: { title: "Reject this company?", button: "Reject" },
};

export function ActionsView({ p, s, h }: { p: Props; s: ViewState; h: Handlers }) {
  if (p.status === "done") return <p className="text-small text-muted">This item is decided. Every action is written to the audit log.</p>;
  const err = s.error && <Notice kind="error">{s.error}</Notice>;
  if (!p.mine)
    return (
      <div className="flex flex-col gap-3">
        {err}
        <p className="text-small text-muted">{p.status === "claimed" ? "Another reviewer holds this item." : "Claim this item to decide it."}</p>
        <Button type="button" onClick={h.onClaim} disabled={s.pending} className="self-start">{p.status === "claimed" ? "Take over the claim" : "Claim this review"}</Button>
      </div>
    );
  const ask = s.ask ? CONFIRM[s.ask] : null;
  return (
    <div className="flex flex-col gap-4">
      {err}
      <Checkbox label={`Add the email domain${p.emailDomain ? ` (${p.emailDomain})` : ""}`} help={p.canAddDomain ? "Colleagues on this domain then join without a review." : "Not offered for a free email provider or an address with no domain."} checked={s.addDomain && p.canAddDomain} disabled={!p.canAddDomain} onChange={(e) => h.onChange({ addDomain: e.target.checked })} />
      <Textarea label="Question for the company (sent by email)" help={`Only for "Ask for more". Plain text, up to ${QUESTION_MAX} characters.`} maxLength={QUESTION_MAX} value={s.question} onChange={(e) => h.onChange({ question: e.target.value })} />
      <Select label="Reason for Reject" value={s.reason} onChange={(e) => h.onChange({ reason: e.target.value })}>
        {REJECT_REASONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
      </Select>
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={() => h.onAsk("approve")} disabled={s.pending}>Approve</Button>
        <Button type="button" variant="chip" size="md" onClick={() => h.onAsk("ask_more")} disabled={s.pending || s.question.trim().length === 0}>Ask for more</Button>
        <Button type="button" variant="danger" onClick={() => h.onAsk("reject")} disabled={s.pending}>Reject</Button>
        <Button type="button" variant="outline" onClick={h.onRelease} disabled={s.pending}>Release</Button>
      </div>
      <p className="text-small text-muted">Every action is written to the audit log.</p>
      <Dialog open={ask !== null} onClose={() => h.onAsk(null)} title={ask?.title ?? ""}>
        <p className="mb-4">
          {s.ask === "approve" && `${p.companyName} becomes verified and its owner is told by email.${s.addDomain && p.canAddDomain ? ` The domain ${p.emailDomain} is saved for the company.` : ""}`}
          {s.ask === "ask_more" && "The company's owner gets your question by email and the review waits for the answer."}
          {s.ask === "reject" && "The owner is told by email. This cannot be undone from here."}
        </p>
        {err}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant={s.ask === "reject" ? "danger" : "primary"} onClick={h.onConfirm} disabled={s.pending}>{ask?.button ?? "Confirm"}</Button>
          <Button type="button" variant="outline" onClick={() => h.onAsk(null)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}

export function Actions(p: Props) {
  const router = useRouter();
  const [s, set] = useState<ViewState>({ ask: null, pending: false, addDomain: false, question: "", reason: REJECT_REASONS[0]![0] });
  const patch = (x: Partial<ViewState>) => set((o) => ({ ...o, ...x }));
  async function send(body: object, leave: boolean) {
    patch({ pending: true, error: undefined });
    const r = await postJson("/api/account-review", { itemId: p.itemId, ...body });
    if (!r.ok) return patch({ pending: false, error: errorWords(r.error, r.status) });
    patch({ pending: false, ask: null });
    if (leave) router.replace(p.listHref);
    router.refresh();
  }
  const handlers: Handlers = {
    onClaim: () => void send({ action: "claim" }, false),
    onRelease: () => void send({ action: "release" }, true),
    onAsk: (ask) => patch({ ask, error: undefined }),
    onChange: patch,
    onConfirm: () => {
      if (s.ask === "approve") void send({ action: "approve", addDomain: s.addDomain && p.canAddDomain }, true);
      else if (s.ask === "ask_more") void send({ action: "ask_more", question: s.question.trim() }, true);
      else if (s.ask === "reject") void send({ action: "reject", reason: s.reason }, true);
    },
  };
  return <ActionsView p={p} s={s} h={handlers} />;
}
