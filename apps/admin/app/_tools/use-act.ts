"use client";
// The browser side of a tool page's write: one JSON POST to a documented route, the words for a refusal, and a refresh of the page when it worked.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { postJson, type Result } from "../_queue/post";
import { toolWords } from "./words";

export type ActState = { pending: boolean; error?: string; reauth?: boolean };

export function useAct(url: string) {
  const router = useRouter();
  const [s, set] = useState<ActState>({ pending: false });
  async function send(body: object): Promise<Result> {
    set({ pending: true });
    const r = await postJson(url, body);
    if (!r.ok) set({ pending: false, error: toolWords(r.error, r.status), reauth: r.error === "reauth_required" });
    else { set({ pending: false }); router.refresh(); }
    return r;
  }
  return { s, send, clear: () => set({ pending: false }) };
}
