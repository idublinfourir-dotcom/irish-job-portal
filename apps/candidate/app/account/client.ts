// The browser side of the account forms: one request helper, and the re-sign-in (DD10). Client components only (never imports @portal/auth).
import { loginPath } from "../../lib/paths";
import type { Res } from "./messages";

/** A request to one of our documented routes from the page (the browser adds the Origin header the route checks). A plain object is sent as JSON, FormData as is. */
export async function send(method: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: object | FormData): Promise<Res & { response?: Response; json?: Record<string, unknown> }> {
  try {
    const init: RequestInit = { method, credentials: "same-origin" };
    if (body instanceof FormData) init.body = body;
    else if (body) { init.body = JSON.stringify(body); init.headers = { "content-type": "application/json" }; }
    const response = await fetch(url, init);
    const json = (await response.clone().json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: response.ok, status: response.status, code: typeof json?.code === "string" ? json.code : undefined, response, json: json ?? undefined };
  } catch {
    return { ok: false, status: 0 };
  }
}

/** DD10, CF129: ends this sign-in and opens the existing sign-in page, which returns to `back` (a path of ours) when it is done. Nothing is lost but the form. */
export async function signInAgain(back: string) {
  await send("POST", "/api/auth/candidate/sign-out", {});
  window.location.assign(loginPath(back));
}
