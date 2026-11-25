"use client";
// Mark one notice, or all of them, read (POST /api/portal/notices). The page then reloads its reads, which also refreshes the bell's count.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@portal/ui";
import { api } from "../(auth)/api";
import { noticeMessage } from "../_jobs/words";

export function MarkRead({ id, all }: { id?: string; all?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string>(), [pending, setPending] = useState(false);
  async function mark() {
    setPending(true); setError(undefined);
    const r = await api("/api/portal/notices", { method: "POST", body: all ? { action: "read_all" } : { action: "read", id } });
    setPending(false);
    if (r.status === 200) router.refresh(); else setError(noticeMessage({ status: r.status, code: r.code }));
  }
  return <span className="inline-flex flex-col items-start gap-1"><Button variant="chip" onClick={mark} disabled={pending}>{all ? "Mark all read" : "Mark read"}</Button>{error && <span role="alert" className="text-small font-semibold text-error">{error}</span>}</span>;
}
