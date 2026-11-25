"use client";
// One button that posts a JSON body to a documented route, asks to confirm first when it has `confirm`, then reloads the page's reads (or goes to `then`) and shows the route's own
// refusal in words when it says no. The view takes its state as props so a test renders every state. The route checks the role, the Origin and the rules again (every one of them).
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Dialog, type ButtonVariant } from "@portal/ui";
import { Failure } from "./failure";
import { postJson, type Result } from "./post";

export type Confirm = { title: string; text: string; button: string };
export type Props = { url: string; body: object; label: string; variant?: ButtonVariant; confirm?: Confirm; then?: string; back: string; disabled?: boolean };
export type Failed = { code: string; status: number } | null;

export function PostButtonView({ p, open, pending, failed, onOpen, onSend, onClose }: { p: Props; open: boolean; pending: boolean; failed: Failed; onOpen: () => void; onSend: () => void; onClose: () => void }) {
  const fail = failed && <Failure code={failed.code} status={failed.status} back={p.back} />;
  return (
    <>
      <Button type="button" variant={p.variant ?? "primary"} size="md" disabled={p.disabled || pending} onClick={p.confirm ? onOpen : onSend}>{p.label}</Button>
      {!open && fail}
      {p.confirm && (
        <Dialog open={open} onClose={onClose} title={p.confirm.title}>
          <p className="mb-4 [overflow-wrap:anywhere]">{p.confirm.text}</p>
          {fail}
          <div className="mt-4 flex gap-2">
            <Button type="button" variant={p.variant === "danger" ? "danger" : "primary"} disabled={pending} onClick={onSend}>{p.confirm.button}</Button>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          </div>
        </Dialog>
      )}
    </>
  );
}

export function PostButton(p: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false), [pending, setPending] = useState(false), [failed, setFailed] = useState<Failed>(null);
  async function send() {
    setPending(true); setFailed(null);
    const r: Result = await postJson(p.url, p.body);
    setPending(false);
    if (!r.ok) return setFailed({ code: r.error, status: r.status });
    setOpen(false);
    if (p.then) router.replace(p.then);
    router.refresh();
  }
  return <PostButtonView p={p} open={open} pending={pending} failed={failed} onOpen={() => { setFailed(null); setOpen(true); }} onSend={() => void send()} onClose={() => setOpen(false)} />;
}
