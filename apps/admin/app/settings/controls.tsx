"use client";
// One setting's two-person controls. Propose a value (an administrator), then a DIFFERENT administrator confirms (the value is written at once) or refuses; the
// proposer can only withdraw. They post to POST /api/settings (docs/openapi/admin.yaml); the route and the database's setting guard check the rule again.
import { useState } from "react";
import { Button, Dialog, Input, Notice } from "@portal/ui";
import { useAct, type ActState } from "../_tools/use-act";
import { toolWords } from "../_tools/words";
import { humanKey } from "../_tools/text";
import { readValue, valueText } from "./text";

export type Pending = { requestId: string; value: number | null; mine: boolean };
export type Props = { settingKey: string; unit: string | null; pending?: Pending };
export type Ui = { ask: boolean; text: string; problem?: string };
export type Handlers = { onText: (t: string) => void; onAsk: (a: boolean) => void; onPropose: () => void; onConfirm: () => void; onRefuse: () => void };

export function ControlsView({ p, s, ui, h }: { p: Props; s: ActState; ui: Ui; h: Handlers }) {
  const err = (s.error ?? ui.problem) && <Notice kind="error">{s.error ?? ui.problem}</Notice>;
  const pend = p.pending;
  if (pend)
    return (
      <div className="flex flex-col gap-3">
        {err}
        <p>{`Waiting for a second administrator: ${valueText(pend.value, p.unit)}, proposed by ${pend.mine ? "you" : "another administrator"}.`}</p>
        <div className="flex flex-wrap gap-2">
          {pend.mine ? (
            <Button type="button" variant="outline" onClick={h.onRefuse} disabled={s.pending}>Withdraw my change</Button>
          ) : (
            <>
              <Button type="button" onClick={() => h.onAsk(true)} disabled={s.pending}>Confirm</Button>
              <Button type="button" variant="outline" onClick={h.onRefuse} disabled={s.pending}>Refuse</Button>
            </>
          )}
        </div>
        {!pend.mine && (
          <Dialog open={ui.ask} onClose={() => h.onAsk(false)} title={`Change ${humanKey(p.settingKey).toLowerCase()}?`}>
            <p className="mb-4">{`The value becomes ${valueText(pend.value, p.unit).toLowerCase()} at once, for everyone. The audit log names both administrators.`}</p>
            {err}
            <div className="mt-4 flex gap-2">
              <Button type="button" onClick={h.onConfirm} disabled={s.pending}>Confirm the change</Button>
              <Button type="button" variant="outline" onClick={() => h.onAsk(false)}>Cancel</Button>
            </div>
          </Dialog>
        )}
      </div>
    );
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (!s.pending) h.onPropose(); }}>
      {err}
      <Input label={`New value${p.unit ? ` (${p.unit})` : ""}`} name="value" inputMode="numeric" pattern="[0-9]{0,6}" maxLength={6} value={ui.text} onChange={(e) => h.onText(e.target.value)} help="A whole number from 0 to 100,000, or empty for not set. A second administrator must confirm it." />
      <Button type="submit" variant="outline" disabled={s.pending} className="self-start">Propose this value</Button>
    </form>
  );
}

export function Controls(p: Props) {
  const { s, send } = useAct("/api/settings");
  const [ui, set] = useState<Ui>({ ask: false, text: "" });
  const h: Handlers = {
    onText: (text) => set((o) => ({ ...o, text, problem: undefined })),
    onAsk: (ask) => set((o) => ({ ...o, ask })),
    onPropose: () => {
      const value = readValue(ui.text);
      if (value === undefined) return set((o) => ({ ...o, problem: toolWords("bad_value", 400) }));
      void send({ action: "propose", key: p.settingKey, value }).then((r) => r.ok && set({ ask: false, text: "" }));
    },
    onConfirm: () => void send({ action: "confirm", requestId: p.pending!.requestId }).then((r) => r.ok && set((o) => ({ ...o, ask: false }))),
    onRefuse: () => void send({ action: "refuse", requestId: p.pending!.requestId }),
  };
  return <ControlsView p={p} s={s} ui={ui} h={h} />;
}
