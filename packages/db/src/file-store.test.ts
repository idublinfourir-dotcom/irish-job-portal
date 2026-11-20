// No real network: s3Store against a fake S3 on 127.0.0.1, checking the requests it sends; the presigned link; the settings; memoryStore.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { disposition, memoryStore, s3Settings, s3Store, SCAN_TAG, SETTINGS, type S3Settings } from "./file-store";

type Seen = { method: string; url: string; headers: IncomingMessage["headers"]; body: Buffer };
const seen: Seen[] = [];
let answer = 200, reply: { body?: Buffer | string; headers?: Record<string, string> } = {};
const server = createServer((req, res) => {
  const parts: Buffer[] = [];
  req.on("data", (c) => parts.push(c)).on("end", () => {
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(parts) });
    res.writeHead(answer, reply.headers).end(reply.body);
  });
});
let s: S3Settings;
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s = { keyId: "AKIAFAKEFAKEFAKE", secret: "fake-secret-fake-secret", bucket: "fake-bucket", region: "eu-west-1", endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
});
afterAll(() => new Promise((r) => server.close(r)));
const last = () => seen.at(-1)!;

describe("s3Store, against a fake S3 on 127.0.0.1", () => {
  it("put: one signed PUT of the bytes at the key, with the content type", async () => {
    answer = 200;
    await s3Store(s).put("cv/abc", new Uint8Array([1, 2, 3]), "application/pdf");
    const r = last();
    expect([r.method, r.url, r.headers["content-type"]]).toEqual(["PUT", "/cv/abc", "application/pdf"]);
    expect(r.body).toEqual(Buffer.from([1, 2, 3]));
    expect(r.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKEFAKEFAKE\/\d{8}\/eu-west-1\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]*host[a-z0-9;-]*x-amz-date[a-z0-9;-]*, Signature=[0-9a-f]{64}$/);
    expect(r.headers["x-amz-date"]).toMatch(/^\d{8}T\d{6}Z$/);
    expect(r.headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });
  it("remove: one signed DELETE; 204 (S3's answer for a missing object too) is fine, anything else throws without the key", async () => {
    answer = 204;
    await s3Store(s).remove("case/xyz");
    expect([last().method, last().url]).toEqual(["DELETE", "/case/xyz"]);
    expect(last().headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    answer = 403;
    await expect(s3Store(s).remove("case/xyz")).rejects.toThrow(/^file store: DELETE answered 403$/);
    answer = 500;
    await expect(s3Store(s).put("case/xyz", new Uint8Array([1]), "image/png")).rejects.toThrow(/^file store: PUT answered 500$/); // after its retries
    answer = 200;
  });
  it("link: a presigned GET at the key, 60 seconds by default, that downloads under the label with our content type; nothing is sent", async () => {
    const n = seen.length;
    const u = new URL(await s3Store(s).link("cv/abc", { fileName: "Mo CV (1).pdf", contentType: "application/pdf" }));
    expect(seen.length).toBe(n);
    expect(`${u.origin}${u.pathname}`).toBe(`${s.endpoint}/cv/abc`);
    const q = u.searchParams;
    expect(q.get("X-Amz-Expires")).toBe("60");
    expect(q.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(q.get("X-Amz-Credential")).toMatch(/^AKIAFAKEFAKEFAKE\/\d{8}\/eu-west-1\/s3\/aws4_request$/);
    expect(q.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(q.get("X-Amz-SignedHeaders")).toBe("host");
    expect(q.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''Mo%20CV%20%281%29.pdf");
    expect(q.get("response-content-type")).toBe("application/pdf");
    expect(u.toString()).not.toContain(s.secret);
    expect(new URL(await s3Store(s).link("k", { fileName: "a", contentType: "image/png", seconds: 300 })).searchParams.get("X-Amz-Expires")).toBe("300");
    for (const seconds of [0, 301, 1.5]) await expect(s3Store(s).link("k", { fileName: "a", contentType: "image/png", seconds })).rejects.toThrow(/1 to 300 seconds/);
  });
  it("get: one signed GET; the bytes and type; 404 is null; over the cap (by header or while reading) throws; other errors name only the status", async () => {
    answer = 200; reply = { body: Buffer.from([1, 2, 3]), headers: { "content-type": "application/pdf" } };
    expect(await s3Store(s).get("case/abc", 10)).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: "application/pdf" });
    expect([last().method, last().url]).toEqual(["GET", "/case/abc"]);
    expect(last().headers.authorization).toMatch(/^AWS4-HMAC-SHA256 /);
    await expect(s3Store(s).get("case/abc", 2)).rejects.toThrow(/^file store: object over the cap$/); // the header says 3
    reply = { body: Buffer.alloc(100, 1), headers: { "transfer-encoding": "chunked" } }; // no length header: counted while reading
    await expect(s3Store(s).get("case/abc", 50)).rejects.toThrow(/over the cap/);
    answer = 404; reply = {};
    expect(await s3Store(s).get("case/gone", 10)).toBeNull();
    answer = 403;
    await expect(s3Store(s).get("case/abc", 10)).rejects.toThrow(/^file store: GET answered 403$/);
    answer = 200; reply = {};
  });
  it("scanStatus: GET ?tagging; the GuardDutyMalwareScanStatus value, null without it or for a missing object", async () => {
    const tagging = (tags: [string, string][]) => `<?xml version="1.0" encoding="UTF-8"?><Tagging xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><TagSet>${
      tags.map(([k, v]) => `<Tag><Key>${k}</Key><Value>${v}</Value></Tag>`).join("")}</TagSet></Tagging>`;
    answer = 200; reply = { body: tagging([["other", "x"], [SCAN_TAG, "NO_THREATS_FOUND"]]) };
    expect(await s3Store(s).scanStatus("case/abc")).toBe("NO_THREATS_FOUND");
    expect([last().method, last().url]).toEqual(["GET", "/case/abc?tagging"]);
    reply = { body: tagging([[SCAN_TAG, "THREATS_FOUND"]]) };
    expect(await s3Store(s).scanStatus("case/abc")).toBe("THREATS_FOUND");
    reply = { body: tagging([]) };
    expect(await s3Store(s).scanStatus("case/abc")).toBeNull();
    answer = 404; reply = {};
    expect(await s3Store(s).scanStatus("case/gone")).toBeNull();
    answer = 403;
    await expect(s3Store(s).scanStatus("case/abc")).rejects.toThrow(/^file store: GET tagging answered 403$/);
    answer = 200; reply = {};
  });
  it("the real address is virtual-hosted in the bucket's region, and the network guard refuses it in tests", async () => {
    const { endpoint, ...real } = s;
    expect(endpoint).toBeDefined();
    expect(new URL(await s3Store(real).link("cv/abc", { fileName: "a.pdf", contentType: "application/pdf" })).host).toBe("fake-bucket.s3.eu-west-1.amazonaws.com");
    const e = await s3Store({ ...real, region: "eu-west-1" }).remove("cv/abc").catch((x: Error) => x);
    expect(String((e as Error & { cause?: Error }).cause ?? e)).toMatch(/real network: fake-bucket\.s3\.eu-west-1\.amazonaws\.com/);
  });
  it("never logs anything", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    try {
      answer = 200;
      await s3Store(s).put("cv/q", new Uint8Array([1]), "application/pdf");
      await s3Store(s).link("cv/q", { fileName: "a", contentType: "application/pdf" });
      answer = 403;
      await s3Store(s).remove("cv/q").catch(() => {});
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally { for (const spy of spies) spy.mockRestore(); answer = 200; }
  });
});

describe("settings", () => {
  const all = { FILES_S3_KEY_ID: "id-value", FILES_S3_SECRET: "secret-value", FILES_S3_BUCKET: "b", FILES_S3_REGION: "eu-west-1" };
  it("reads the four FILES_S3_ names", () => {
    expect(s3Settings(all)).toEqual({ keyId: "id-value", secret: "secret-value", bucket: "b", region: "eu-west-1" });
    expect(Object.values(SETTINGS)).toEqual(["FILES_S3_KEY_ID", "FILES_S3_SECRET", "FILES_S3_BUCKET", "FILES_S3_REGION"]);
  });
  it("a missing one is named, a value never shown, and AWS_* is never read", () => {
    const e = (() => { try { s3Settings({ ...all, FILES_S3_SECRET: "" }); } catch (x) { return x as Error; } })()!;
    expect(e.message).toBe("file storage is off: FILES_S3_SECRET not set");
    expect(() => s3Settings({ AWS_ACCESS_KEY_ID: "a", AWS_SECRET_ACCESS_KEY: "b", AWS_REGION: "eu-west-1" })).toThrow(/FILES_S3_KEY_ID, FILES_S3_SECRET, FILES_S3_BUCKET, FILES_S3_REGION not set/);
  });
});

describe("disposition", () => {
  it("percent-encodes the UTF-8 name, quotes and brackets included, so no header can be broken", () => {
    expect(disposition("naïve CV.pdf")).toBe("attachment; filename*=UTF-8''na%C3%AFve%20CV.pdf");
    expect(disposition(`a"b';c\r\nSet-Cookie: x=1 (2)*!.pdf`)).toBe("attachment; filename*=UTF-8''a%22b%27%3Bc%0D%0ASet-Cookie%3A%20x%3D1%20%282%29%2A%21.pdf");
    expect(disposition("Ó Briain.png")).toBe("attachment; filename*=UTF-8''%C3%93%20Briain.png");
  });
});

describe("memoryStore", () => {
  it("get and scanStatus: the bytes, the cap, a set tag, null for no tag, scanDefault for the rest, null for a missing object", async () => {
    const m = memoryStore();
    await m.put("k", new Uint8Array([1, 2]), "image/png");
    expect(await m.get("k", 2)).toEqual({ bytes: new Uint8Array([1, 2]), contentType: "image/png" });
    await expect(m.get("k", 1)).rejects.toThrow(/over the cap/);
    expect(await m.get("none", 9)).toBeNull();
    expect(await m.scanStatus("k")).toBe("NO_THREATS_FOUND");
    m.tags.set("k", "THREATS_FOUND"); expect(await m.scanStatus("k")).toBe("THREATS_FOUND");
    m.tags.set("k", null); expect(await m.scanStatus("k")).toBeNull();
    m.tags.delete("k"); m.scanDefault = null; expect(await m.scanStatus("k")).toBeNull();
    expect(await m.scanStatus("none")).toBeNull();
  });
  it("keeps, links and removes; a missing object removes fine; failNext fails one call", async () => {
    const m = memoryStore();
    await m.put("k", new Uint8Array([7]), "image/png");
    expect(m.objects.get("k")).toEqual({ bytes: new Uint8Array([7]), contentType: "image/png" });
    expect(new URL(await m.link("k", { fileName: "a b.png", contentType: "image/png" })).searchParams.get("response-content-disposition")).toBe("attachment; filename*=UTF-8''a%20b.png");
    await m.remove("k"); await m.remove("k");
    expect(m.objects.size).toBe(0);
    m.failNext();
    await expect(m.put("k", new Uint8Array([1]), "x")).rejects.toThrow(/fake failure/);
    await m.put("k", new Uint8Array([1]), "x");
    expect(m.objects.size).toBe(1);
  });
});
