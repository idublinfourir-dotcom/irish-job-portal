"use client";
// The controls of a services case: assign, move the status, ask for documents (codes), record the outcome, close, refer and add a note. Each posts to
// POST /api/services/cases (docs/openapi/admin.yaml), which checks the role, the assignment, the Origin and the requester's email again and writes the audit row. Everything but
// a note asks to confirm first, because the requester gets a notice (and for documents, the decision, close and refer, an email). ActionsView takes its state as props so a test renders every state.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Checkbox, Dialog, Notice, Select, Textarea } from "@portal/ui";
import { postJson } from "../../_queue/post";
import { COPIES_NOTE, DOC_CODES, MOVES, SCOPE_NOTE, statusLabel, words } from "../text";

export type Props = {
  caseId: string; status: string; outcome: string | null; held: "me" | "none" | "other"; isHandler: boolean; isAdmin: boolean; meId: string;
  handlers: { id: string; name: string }[]; solicitors: { id: string; firm: string }[];
};
export type Ask = { title: string; text: string; button: string; danger?: boolean; body: Record<string, unknown> };
export type ViewState = { ask: Ask | null; pending: boolean; error?: string; done?: boolean; codes: string[]; note: string; reason: string; solicitor: string; assignTo: string };
export type Handlers = { onAsk: (a: Ask | null) => void; onConfirm: () => void; onNote: () => void; onChange: (p: Partial<ViewState>) => void };

export const NOTE_MAX = 2000;
/** The close reasons that make sense now: "decided" only with an outcome, the others only without one (the route enforces the same). */
export const closeReasons = (outcome: string | null): [string, string][] => (outcome ? [["decided", "Decided"]] : [["employer_not_engaged", "Employer did not engage"], ["no_reply", "No reply"]]);

export function ActionsView({ p, s, h }: { p: Props; s: ViewState; h: Handlers }) {
  if (p.status === "closed") return <p className="text-small text-muted">This case is closed. Every action is written to the audit log.</p>;
  const err = s.error && <Notice kind="error">{s.error}</Notice>;
  const mine = p.isHandler && p.held === "me";
  const ask = s.ask;
  const reasons = closeReasons(p.outcome);
  return (
    <div className="flex flex-col gap-5">
      {err}
      {!ask && s.done && <Notice kind="success">Saved.</Notice>}
      {(p.isAdmin && p.handlers.length > 0) ? (
        <div className="flex flex-col gap-2">
          <Select label="Assign to" value={s.assignTo} onChange={(e) => h.onChange({ assignTo: e.target.value })}>
            <option value="">Pick a handler</option>
            {p.handlers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
          <Button type="button" variant="outline" className="self-start" disabled={s.pending || s.assignTo === ""} onClick={() => h.onAsk({ title: "Assign this case?", text: "The handler is the only person who can then work on it.", button: "Assign", body: { action: "assign", staffUserId: s.assignTo } })}>Assign</Button>
        </div>
      ) : p.isHandler && p.held === "none" ? (
        <Button type="button" className="self-start" disabled={s.pending} onClick={() => h.onAsk({ title: "Take this case?", text: "You become the handler and the only person who can work on it.", button: "Take the case", body: { action: "assign", staffUserId: p.meId } })}>Take this case</Button>
      ) : null}
      {p.isHandler && p.held === "other" && <p className="text-small text-muted">Another handler holds this case, so only they can work on it.</p>}
      {mine && (
        <>
          {(MOVES[p.status] ?? []).length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-small font-semibold">Move the case</p>
              <div className="flex flex-wrap gap-2">
                {(MOVES[p.status] ?? []).map((to) => (
                  <Button key={to} type="button" variant="chip" size="md" disabled={s.pending} onClick={() => h.onAsk({ title: `Move to "${statusLabel(to)}"?`, text: "The requester gets a notice.", button: "Move", body: { action: "status", status: to } })}>{statusLabel(to)}</Button>
                ))}
              </div>
            </div>
          )}
          {p.status === "decision" && p.outcome === null && (
            <div className="flex flex-col gap-2">
              <p className="text-small font-semibold">Record the outcome</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" disabled={s.pending} onClick={() => h.onAsk({ title: "Record that the permit was granted?", text: "The requester gets a notice and an email with no details.", button: "Granted", body: { action: "decision", outcome: "granted" } })}>Granted</Button>
                <Button type="button" variant="danger" disabled={s.pending} onClick={() => h.onAsk({ title: "Record that the permit was refused?", text: "The requester gets a notice and an email with no details.", button: "Refused", danger: true, body: { action: "decision", outcome: "refused" } })}>Refused</Button>
              </div>
            </div>
          )}
          {p.status !== "decision" && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-small font-semibold">Ask for documents</legend>
              {DOC_CODES.map(([code, label]) => (
                <Checkbox key={code} label={label} checked={s.codes.includes(code)} onChange={(e) => h.onChange({ codes: e.target.checked ? [...s.codes, code] : s.codes.filter((c) => c !== code) })} />
              ))}
              <p className="text-small text-muted">{COPIES_NOTE}</p>
              <Button type="button" variant="outline" className="self-start" disabled={s.pending || s.codes.length === 0} onClick={() => h.onAsk({ title: "Ask for these documents?", text: "The requester gets a notice and an email with no details.", button: "Ask", body: { action: "documents", codes: s.codes } })}>Ask for documents</Button>
            </fieldset>
          )}
          <div className="flex flex-col gap-2">
            <Select label="Close the case" value={s.reason} onChange={(e) => h.onChange({ reason: e.target.value })}>
              {reasons.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </Select>
            <Button type="button" variant="outline" className="self-start" disabled={s.pending} onClick={() => h.onAsk({ title: "Close this case?", text: "The requester gets a notice and an email. A closed case cannot be reopened.", button: "Close the case", danger: true, body: { action: "close", reason: reasons.some(([k]) => k === s.reason) ? s.reason : reasons[0]![0] } })}>Close the case</Button>
          </div>
          <div className="flex flex-col gap-2">
            <Select label="Refer to a solicitor" help="Pick a firm, or leave blank to refer without naming one." value={s.solicitor} onChange={(e) => h.onChange({ solicitor: e.target.value })}>
              <option value="">No firm named</option>
              {p.solicitors.map((x) => <option key={x.id} value={x.id}>{x.firm}</option>)}
            </Select>
            <Button type="button" variant="outline" className="self-start" disabled={s.pending} onClick={() => h.onAsk({ title: "Refer this case to a solicitor?", text: "The case closes as referred. The requester gets a notice and an email.", button: "Refer", danger: true, body: { action: "refer", ...(s.solicitor ? { solicitorId: s.solicitor } : {}) } })}>Refer to solicitor</Button>
            <p className="text-small text-muted">{SCOPE_NOTE}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Textarea label="Add a note" help={`Staff only, never shown to the requester. Up to ${NOTE_MAX} characters.`} maxLength={NOTE_MAX} value={s.note} onChange={(e) => h.onChange({ note: e.target.value })} />
            <Button type="button" variant="outline" className="self-start" disabled={s.pending || s.note.trim().length === 0} onClick={h.onNote}>Add note</Button>
          </div>
        </>
      )}
      <p className="text-small text-muted">Every action is written to the audit log.</p>
      <Dialog open={ask !== null} onClose={() => h.onAsk(null)} title={ask?.title ?? ""}>
        <p className="mb-4">{ask?.text}</p>
        {err}
        <div className="mt-4 flex gap-2">
          <Button type="button" variant={ask?.danger ? "danger" : "primary"} onClick={h.onConfirm} disabled={s.pending}>{ask?.button ?? "Confirm"}</Button>
          <Button type="button" variant="outline" onClick={() => h.onAsk(null)}>Cancel</Button>
        </div>
      </Dialog>
    </div>
  );
}

export function Actions(p: Props) {
  const router = useRouter();
  const [s, set] = useState<ViewState>({ ask: null, pending: false, codes: [], note: "", reason: closeReasons(p.outcome)[0]![0], solicitor: "", assignTo: "" });
  const patch = (x: Partial<ViewState>) => set((o) => ({ ...o, ...x }));
  async function send(body: Record<string, unknown>, reset: Partial<ViewState>) {
    patch({ pending: true, error: undefined, done: false });
    const r = await postJson("/api/services/cases", { ...body, caseId: p.caseId });
    if (!r.ok) return patch({ pending: false, error: words(r.error, r.status) });
    patch({ pending: false, ask: null, done: true, ...reset });
    router.refresh();
  }
  const handlers: Handlers = {
    onAsk: (ask) => patch({ ask, error: undefined }),
    onChange: patch,
    onConfirm: () => (s.ask ? void send(s.ask.body, { codes: [], assignTo: "" }) : undefined),
    onNote: () => void send({ action: "note", body: s.note.trim() }, { note: "" }),
  };
  return <ActionsView p={p} s={s} h={handlers} />;
}
