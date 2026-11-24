// The browser side of the forms: one JSON call to a documented route, answered as { status, code, body }. status 0 is "no answer" (offline). Used by client components only.
import type { Answer } from "./messages";

export type Reply = Answer & { body: Record<string, unknown> };

export async function api(url: string, init?: { method: "POST"; body: object; signal?: AbortSignal } | { signal?: AbortSignal }): Promise<Reply> {
  try {
    const post = init && "body" in init;
    const res = await fetch(url, { method: post ? "POST" : "GET", headers: post ? { "content-type": "application/json" } : undefined, body: post ? JSON.stringify(init.body) : undefined, credentials: "same-origin", signal: init?.signal });
    const body = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { status: res.status, code: typeof body.code === "string" ? body.code : undefined, body };
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    return { status: 0, body: {} };
  }
}
export const AUTH = "/api/auth/portal";
export const fields = (e: { currentTarget: HTMLFormElement }) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
/** The address the emailed confirmation link ends on (our own page); `next` is a path already checked on the server. */
export const verifyCallback = (next: string | null) => `/verify-email${next ? `?next=${encodeURIComponent(next)}` : ""}`;
