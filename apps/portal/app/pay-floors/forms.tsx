"use client";
// DD33: sign a pay floor and withdraw one (POST /api/portal/pay-floors). A session older than 10 minutes answers REAUTH_REQUIRED: the page sends the person to the sign-in page
// and back here (DD10, CF129), never a password box of its own.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { A, Button, Checkbox, Input, Notice } from "@portal/ui";
import { api } from "../(auth)/api";
import { floorMessage, needsSignIn, signInTo } from "../_jobs/words";

type Failed = { message: string; again: boolean };
export function SignView({ error, pending, onSubmit, textId }: { error?: Failed; pending?: boolean; onSubmit?: (f: FormData) => void; textId: string | null }) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit?.(new FormData(e.currentTarget)); }} className="flex flex-col gap-4" aria-busy={pending || undefined}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Role family code" name="roleFamily" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} required help="The four-digit occupation code (SOC 2010) of the role." />
        <Input label="Pay floor in euro a year" name="floorEur" inputMode="numeric" pattern="[0-9]{1,7}" maxLength={7} required help="A whole number. You pay at least this for the role for 12 months." />
      </div>
      <Checkbox name="agree" label="I have read the wording above and I sign it for my company" required />
      {error && <Notice kind={error.again ? "warning" : "error"}>{error.message}{error.again && <span className="mt-2 block"><A href={signInTo("/pay-floors")} className="font-semibold underline">Sign in again</A></span>}</Notice>}
      <Button type="submit" variant="dark" disabled={pending || !textId} className="self-start">{pending ? "Signing" : "Sign the pay floor"}</Button>
    </form>
  );
}

export function SignFloor({ textId }: { textId: string | null }) {
  const router = useRouter();
  const [error, setError] = useState<Failed>(), [pending, setPending] = useState(false);
  async function submit(f: FormData) {
    setPending(true); setError(undefined);
    const r = await api("/api/portal/pay-floors", { method: "POST", body: { action: "sign", roleFamily: String(f.get("roleFamily") ?? "").trim(), floorEur: Number(f.get("floorEur")), consentTextId: textId } });
    setPending(false);
    const a = { status: r.status, code: r.code };
    if (r.status === 200) router.refresh(); else setError({ message: floorMessage(a), again: needsSignIn(a) });
  }
  return <SignView error={error} pending={pending} onSubmit={submit} textId={textId} />;
}

export function Withdraw({ id }: { id: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function go() {
    setPending(true); setError(undefined);
    const r = await api("/api/portal/pay-floors", { method: "POST", body: { action: "withdraw", floorId: id } });
    setPending(false);
    if (r.status === 200) router.refresh(); else setError(floorMessage({ status: r.status, code: r.code }));
  }
  return <span className="inline-flex flex-col items-start gap-1"><Button variant="chip" onClick={go} disabled={pending}>{pending ? "Withdrawing" : "Withdraw"}</Button>{error && <span role="alert" className="text-small font-semibold text-error">{error}</span>}</span>;
}
