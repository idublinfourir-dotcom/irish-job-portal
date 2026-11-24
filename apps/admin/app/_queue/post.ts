"use client";
// The browser side of a staff write: one JSON POST to a documented route (the browser adds the Origin header the route checks). Returns the route's error code,
// never a thrown error, so a form can show the words for it.
export type Result = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string; stage?: string };

export async function postJson(url: string, body: object): Promise<Result> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const j = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (res.ok) return { ok: true, body: j ?? {} };
    return { ok: false, status: res.status, error: typeof j?.error === "string" ? j.error : "", ...(typeof j?.stage === "string" ? { stage: j.stage } : {}) };
  } catch {
    return { ok: false, status: 0, error: "" };
  }
}
