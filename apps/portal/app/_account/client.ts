// P21: the browser side of the forms: one call to a documented route, answered as { status, code, body }. status 0 is "no answer" (offline). Client components only.
import { AUTH } from "../(auth)/api";
import type { Answer } from "./messages";

export type Reply = Answer & { body: Record<string, unknown> };

export async function send(url: string, method: "GET" | "POST" | "PUT" | "DELETE", body?: object | FormData): Promise<Reply> {
  try {
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await fetch(url, { method, headers: body && !form ? { "content-type": "application/json" } : undefined, body: body ? (form ? body : JSON.stringify(body)) : undefined, credentials: "same-origin" });
    const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    return { status: res.status, code: typeof json.code === "string" ? json.code : undefined, body: json };
  } catch {
    return { status: 0, body: {} };
  }
}

/** A full page load of one of our own paths, so nothing of the signed-in page stays on screen. */
export const go = (path: string) => window.location.assign(new URL(path, window.location.origin).href);

/** DD10: a route answered REAUTH_REQUIRED. End this session and open the sign-in page, which brings the person back to `here` (a path of ours, checked there by ownPath). */
export async function reauth(here: string): Promise<void> {
  await send(`${AUTH}/sign-out`, "POST", {});
  go(`/sign-in?next=${encodeURIComponent(here)}`);
}
