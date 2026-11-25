"use client";
// The two-person controls of the legal texts: a content editor proposes a version, a DIFFERENT administrator confirms (it is published at once) or refuses; the
// proposer can only withdraw. They post to POST /api/legal-texts (docs/openapi/admin.yaml). Proposing and confirming need a sign-in in the last 10 minutes
// (C4): the route answers reauth_required and the page offers to sign in again and come back.
import { useState } from "react";
import { Button, Dialog, Input, Notice, Textarea } from "@portal/ui";
import { ReauthNotice } from "../_tools/reauth";
import { useAct, type ActState } from "../_tools/use-act";
import { toolWords } from "../_tools/words";
import { MAX_BODY, proposalProblem } from "./text";

export type PendingProposal = { requestId: string; version: string; mine: boolean };
export type ControlsProps = { purpose: string; label: string; pending?: PendingProposal; isAdmin: boolean; canPropose: boolean };
export type Ui = { ask: boolean; version: string; body: string; problem?: string };
export type Handlers = { onField: (p: Partial<Ui>) => void; onAsk: (a: boolean) => void; onPropose: () => void; onConfirm: () => void; onRefuse: () => void };

export function ControlsView({ p, s, ui, h }: { p: ControlsProps; s: ActState; ui: Ui; h: Handlers }) {
  const msg = s.error ?? ui.problem;
  const err = s.reauth ? <ReauthNotice back="/legal-texts" /> : msg ? <Notice kind="error">{msg}</Notice> : null;
  const pend = p.pending;
  if (pend)
    return (
      <div className="flex flex-col gap-3">
        {err}
        <p>{`Version ${pend.version} is waiting for a second person.`}</p>
        <div className="flex flex-wrap gap-2">
          {pend.mine ? (
            <Button type="button" variant="outline" onClick={h.onRefuse} disabled={s.pending}>Withdraw my proposal</Button>
          ) : p.isAdmin ? (
            <>
              <Button type="button" onClick={() => h.onAsk(true)} disabled={s.pending}>Confirm and publish</Button>
              <Button type="button" variant="outline" onClick={h.onRefuse} disabled={s.pending}>Refuse</Button>
            </>
          ) : (
            <p className="text-small text-muted">An administrator who did not propose it confirms or refuses it.</p>
          )}
        </div>
        {!pend.mine && p.isAdmin && (
          <Dialog open={ui.ask} onClose={() => h.onAsk(false)} title={`Publish version ${pend.version}?`}>
            <p className="mb-4">{`${p.label} version ${pend.version} is published at once. New sign-ups consent to it from then on. People who already signed up are not asked again. Read the text above before you confirm.`}</p>
            {err}
            <div className="mt-4 flex gap-2">
              <Button type="button" onClick={h.onConfirm} disabled={s.pending}>Publish it</Button>
              <Button type="button" variant="outline" onClick={() => h.onAsk(false)}>Cancel</Button>
            </div>
          </Dialog>
        )}
      </div>
    );
  if (!p.canPropose) return <p className="text-small text-muted">A content editor proposes a new version. Then a different administrator publishes it.</p>;
  return (
    <details open={!!err || undefined}>
    <summary className="min-h-11 cursor-pointer py-2.5 font-semibold">Propose a new version</summary>
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!s.pending) h.onPropose(); }}>
      {err}
      <Input label="Version label" name="version" maxLength={64} value={ui.version} onChange={(e) => h.onField({ version: e.target.value })} help="Lower-case letters, digits, dots, dashes and underscores, for example 2026-12-01." />
      <Textarea label="New text (plain text)" name="body" rows={10} maxLength={MAX_BODY} value={ui.body} onChange={(e) => h.onField({ body: e.target.value })} help="Up to 100,000 characters. Line breaks are kept. This is the whole text, not a change." />
      <Button type="submit" variant="outline" disabled={s.pending} className="self-start">Propose this version</Button>
    </form>
    </details>
  );
}

export function Controls(p: ControlsProps) {
  const { s, send } = useAct("/api/legal-texts");
  const [ui, set] = useState<Ui>({ ask: false, version: "", body: "" });
  const h: Handlers = {
    onField: (x) => set((o) => ({ ...o, ...x, problem: undefined })),
    onAsk: (ask) => set((o) => ({ ...o, ask })),
    onPropose: () => {
      const bad = proposalProblem(ui.version, ui.body);
      if (bad) return set((o) => ({ ...o, problem: toolWords(bad, 400) }));
      void send({ action: "propose", purpose: p.purpose, version: ui.version, body: ui.body }).then((r) => r.ok && set({ ask: false, version: "", body: "" }));
    },
    onConfirm: () => void send({ action: "confirm", requestId: p.pending!.requestId }).then((r) => r.ok && set((o) => ({ ...o, ask: false }))),
    onRefuse: () => void send({ action: "refuse", requestId: p.pending!.requestId }),
  };
  return <ControlsView p={p} s={s} ui={ui} h={h} />;
}
