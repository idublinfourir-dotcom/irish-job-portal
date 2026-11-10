import { describe, expect, it } from "vitest";
import { chatClient } from "./client";

const KEY = "sk-test-SECRET-KEY-123";
const prompt = { system: "S", user: "U" };
const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

type Call = { url: string; init: RequestInit };
const fakeFetch = (handler: (c: Call) => Response | Promise<Response>) => {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c = { url: String(input), init: init ?? {} };
    calls.push(c);
    return handler(c);
  }) as typeof fetch;
  return { fetch: f, calls };
};
const client = (f: typeof fetch, extra: Partial<Parameters<typeof chatClient>[0]> = {}) => chatClient({ fetch: f, baseUrl: "https://models.example/api/v1/", key: KEY, model: "vendor/model:free", ...extra });

describe("chatClient", () => {
  it("posts the chat completions request through the fetch it is given, and nowhere else", async () => {
    const f = fakeFetch(() => ok("hello"));
    const globalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the global fetch was called");
    }) as typeof fetch;
    try {
      expect(await client(f.fetch)(prompt)).toBe("hello");
    } finally {
      globalThis.fetch = globalFetch;
    }
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(url).toBe("https://models.example/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json", authorization: `Bearer ${KEY}` });
    expect(JSON.parse(init.body as string)).toEqual({ model: "vendor/model:free", temperature: 0, messages: [{ role: "system", content: "S" }, { role: "user", content: "U" }] });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.redirect).toBe("error");
  });

  it("does not read the environment", async () => {
    const before = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = "env-key-should-not-be-used";
    try {
      const f = fakeFetch(() => ok("x"));
      await client(f.fetch)(prompt);
      expect(JSON.stringify(f.calls)).not.toContain("env-key-should-not-be-used");
    } finally {
      if (before === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = before;
    }
  });

  it("times out through the abort signal", async () => {
    const f = fakeFetch(({ init }) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(init.signal!.reason))));
    await expect(client(f.fetch, { timeoutMs: 20 })(prompt)).rejects.toThrow("model call timed out");
  });

  it("an HTTP error says the status only, not the body", async () => {
    const f = fakeFetch(() => new Response(`rate limited, your key ${KEY} is over quota`, { status: 429 }));
    const e = await client(f.fetch)(prompt).catch((x: Error) => x);
    expect((e as Error).message).toBe("model host answered HTTP 429");
  });

  it("scrubs the key from a network error", async () => {
    const f = fakeFetch(() => {
      throw new TypeError(`fetch failed: bad header Bearer ${KEY}`);
    });
    const e = (await client(f.fetch)(prompt).catch((x: Error) => x)) as Error;
    expect(e.message).toContain("[key]");
    expect(e.message).not.toContain(KEY);
  });

  it.each([
    ["not JSON", new Response("<html>" + KEY, { status: 200 })],
    ["no choices", new Response("{}", { status: 200 })],
    ["a non-text message", ok(42)],
    ["a body over 1 MB", new Response("x".repeat(1_000_001), { status: 200 })],
    ["a content-length over 1 MB", new Response("{}", { status: 200, headers: { "content-length": "9999999" } })],
  ])("refuses %s without echoing the body", async (_n, res) => {
    const e = (await client(fakeFetch(() => res).fetch)(prompt).catch((x: Error) => x)) as Error;
    expect(e).toBeInstanceOf(Error);
    expect(e.message).not.toContain(KEY);
    expect(e.message).not.toContain("<html>");
  });

  it("refuses plain http except to the local machine, because the key travels with it", () => {
    const f = fakeFetch(() => ok("x"));
    expect(() => client(f.fetch, { baseUrl: "http://models.example/v1" })).toThrow(/https/);
    expect(() => client(f.fetch, { baseUrl: "http://localhost:11434/v1" })).not.toThrow();
  });
});
