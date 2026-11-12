// The Brevo sender and the switch, with an injected fetch. No test reaches the network (vitest.setup.ts blocks it as well).
import { describe, expect, it, vi } from "vitest";
import { createBrevoMail, BREVO_URL } from "./brevo";
import { createMail, emailText } from "./mail";

const KEY = "xkeysib-SECRET-KEY-123";
const ok = (status = 201) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ messageId: "<1@x>" }), { status }));
const thrown = (p: Promise<unknown>) => p.then(() => { throw new Error("did not throw"); }, (e: Error) => e);
const mailWith = (f: typeof fetch, timeoutMs?: number) => createBrevoMail({ apiKey: KEY, from: "no-reply@example.com", fetch: f, timeoutMs });

describe("createBrevoMail", () => {
  it("posts the documented request: url, api-key header only, sender, to, subject, textContent", async () => {
    const f = ok();
    await mailWith(f as unknown as typeof fetch)("pat@example.com", "Hi", "Body text");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(BREVO_URL);
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ "api-key": KEY, "content-type": "application/json" });
    expect(JSON.parse(init!.body as string)).toEqual({ sender: { email: "no-reply@example.com" }, to: [{ email: "pat@example.com" }], subject: "Hi", textContent: "Body text" });
    expect(String(init!.body)).not.toContain(KEY);
    expect(String(url)).not.toContain(KEY);
    expect(init!.redirect).toBe("error");
  });
  it("accepts 201 and 202", async () => {
    await expect(mailWith(ok(202) as unknown as typeof fetch)("pat@example.com", "s", "t")).resolves.toBeUndefined();
  });
  it("turns an error status into a thrown error with the status and code, never the key or the address", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ code: "unauthorized", message: `bad key ${KEY} for pat@example.com` }), { status: 401 }));
    const e = await thrown(mailWith(f as unknown as typeof fetch)("pat@example.com", "s", "t"));
    expect(e.message).toBe("Brevo send failed: HTTP 401 unauthorized");
    expect(e.message).not.toContain(KEY);
    const g = vi.fn(async () => new Response("<html>gateway</html>", { status: 502 }));
    await expect(mailWith(g as unknown as typeof fetch)("pat@example.com", "s", "t")).rejects.toThrow("Brevo send failed: HTTP 502");
  });
  it("turns a network error and a timeout into thrown errors that hold no secret", async () => {
    const down = vi.fn(async () => { throw Object.assign(new Error(`connect failed with ${KEY}`), { name: "TypeError" }); });
    const e = await thrown(mailWith(down as unknown as typeof fetch)("pat@example.com", "s", "t"));
    expect(e.message).toBe("Brevo send failed: network error");
    const hang = vi.fn((_u: unknown, init?: RequestInit) => new Promise<Response>((_, rej) => init!.signal!.addEventListener("abort", () => rej(init!.signal!.reason))));
    await expect(mailWith(hang as unknown as typeof fetch, 20)("pat@example.com", "s", "t")).rejects.toThrow("Brevo send failed: timeout");
  });
  it("refuses hostile recipients before any request", async () => {
    const f = ok();
    const send = mailWith(f as unknown as typeof fetch);
    for (const bad of ["", "no-at", "a@b.com,c@d.com", "a@b.com\r\nBcc: x@y.com", "Pat <a@b.com>", "a b@c.com", "a@b.com;c@d.com", '"a"@b.com', "a@b.com>", "x".repeat(300) + "@b.com"])
      await expect(send(bad, "s", "t"), JSON.stringify(bad)).rejects.toThrow("recipient");
    expect(f).not.toHaveBeenCalled();
  });
  it("refuses an empty key or a bad sender address at construction", () => {
    expect(() => createBrevoMail({ apiKey: "", from: "a@b.com" })).toThrow("BREVO_API_KEY");
    expect(() => createBrevoMail({ apiKey: KEY, from: "Name <a@b.com>" })).toThrow("EMAIL_FROM");
  });
});

describe("createMail (the switch)", () => {
  const local = "http://localhost:3000";
  const lines: string[] = [];
  const print = (l: string) => void lines.push(l);
  it("uses the fake sender with neither setting on localhost, exactly as before", async () => {
    const m = createMail(local, {}, print);
    await m.send("portal", "verify", "pat@example.com", "http://localhost:3000/x");
    expect(m.outbox).toEqual([{ pool: "portal", kind: "verify", to: "pat@example.com", link: "http://localhost:3000/x" }]);
  });
  it("fails closed with neither setting on Vercel, in production, or off localhost", () => {
    expect(() => createMail(local, { VERCEL: "1" })).toThrow("fake email sender");
    expect(() => createMail(local, { NODE_ENV: "production" })).toThrow("fake email sender");
    expect(() => createMail("https://portal.example.com", {})).toThrow("fake email sender");
  });
  it("refuses to start when only one of the two settings is set", () => {
    expect(() => createMail(local, { BREVO_API_KEY: KEY })).toThrow("together");
    expect(() => createMail(local, { EMAIL_FROM: "a@b.com", VERCEL: "1" })).toThrow("together");
  });
  it("uses Brevo when both are set (also on Vercel), keeping nothing in memory", async () => {
    const f = ok();
    const m = createMail("https://portal.example.com", { BREVO_API_KEY: KEY, EMAIL_FROM: "no-reply@example.com", VERCEL: "1", NODE_ENV: "production" }, print, f as unknown as typeof fetch);
    await m.send("candidate", "reset", "pat@example.com", "https://x.example.com/reset?t=abc");
    const body = JSON.parse(f.mock.calls[0]![1]!.body as string);
    expect(body.subject).toBe("Reset your password");
    expect(body.textContent).toContain("https://x.example.com/reset?t=abc");
    expect(m.outbox).toEqual([]);
  });
  it("has wording for verify, reset and invite", () => {
    for (const k of ["verify", "reset", "invite"] as const) {
      const [s, t] = emailText(k, "https://l.example.com/a");
      expect(s.length).toBeGreaterThan(5);
      expect(t).toContain("https://l.example.com/a");
    }
  });
  it("a Brevo failure reaches the caller as a thrown error (the portal turns it into EMAIL_FAILED)", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    const m = createMail(local, { BREVO_API_KEY: KEY, EMAIL_FROM: "a@b.com" }, print, f as unknown as typeof fetch);
    await expect(m.send("portal", "invite", "pat@example.com", "http://localhost:3000/i")).rejects.toThrow("HTTP 500");
  });
});
