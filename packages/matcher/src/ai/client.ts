import type { ModelClient } from "./types";

export type ChatClientOptions = {
  /** The fetch to use. The client never calls the global one and never reads the environment. */
  fetch: typeof fetch;
  /** For example https://openrouter.ai/api/v1 */
  baseUrl: string;
  key: string;
  model: string;
  timeoutMs?: number;
};

const MAX_BODY = 1_000_000;

/** One real client for the chat completions shape OpenRouter and most hosts share. Errors never carry the key or the reply body. */
export function chatClient(o: ChatClientOptions): ModelClient {
  const url = new URL(`${o.baseUrl.replace(/\/+$/, "")}/chat/completions`);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("model address must be https (the key travels with every request)");
  const scrub = (s: string) => (o.key ? s.split(o.key).join("[key]") : s); // an empty key (a local model) would split every character
  return async ({ system, user }) => {
    try {
      const res = await o.fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${o.key}` },
        body: JSON.stringify({ model: o.model, temperature: 0, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
        signal: AbortSignal.timeout(o.timeoutMs ?? 60_000),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`model host answered HTTP ${res.status}`);
      if (Number(res.headers.get("content-length") ?? 0) > MAX_BODY) throw new Error("model reply too large");
      const body = await res.text();
      if (body.length > MAX_BODY) throw new Error("model reply too large");
      let parsed: { choices?: { message?: { content?: unknown } }[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("model reply is not JSON"); // not the parser's message: it can quote the reply
      }
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("model reply has no message text");
      return content;
    } catch (e) {
      if (e instanceof Error && e.name === "TimeoutError") throw new Error("model call timed out");
      throw new Error(scrub(e instanceof Error ? e.message : "model call failed"));
    }
  };
}
