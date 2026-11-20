// Unit: the live scan check script (file-scan-check-cli.ts) against the memory fake, with a fake clock: no network, no waiting.
import { describe, expect, it } from "vitest";
import { memoryStore } from "./file-store";
import { EICAR, main } from "./file-scan-check-cli";

const run = async (onPut: (store: ReturnType<typeof memoryStore>, key: string, body: string) => void, wait = { everyMs: 10_000, maxMs: 300_000 }) => {
  const store = memoryStore(), lines: string[] = [];
  store.scanDefault = null; // the scan off: no tag
  const put = store.put.bind(store), puts: string[] = [];
  store.put = async (key, bytes, type) => { await put(key, bytes, type); puts.push(key); onPut(store, key, new TextDecoder().decode(bytes)); };
  let sleeps = 0;
  const code = await main({}, (l) => lines.push(l), { store, wait, sleep: async () => { sleeps++; } });
  return { code, lines, sleeps, store, puts };
};

describe("the live scan check", () => {
  it("puts a clean file and the EICAR string, reports each status, removes both, exits 0 on the expected pair", async () => {
    const r = await run((s, key, body) => s.tags.set(key, body === EICAR ? "THREATS_FOUND" : "NO_THREATS_FOUND"));
    expect(r.code).toBe(0);
    expect(r.lines).toEqual([expect.stringMatching(/^clean: NO_THREATS_FOUND after \d+ s$/), expect.stringMatching(/^eicar: THREATS_FOUND after \d+ s$/)]);
    expect(r.puts).toHaveLength(2);
    expect(r.puts.every((k) => /^check\/[0-9a-f-]{36}$/.test(k))).toBe(true);
    expect(r.store.objects.size).toBe(0);
    expect(EICAR).toBe("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
  });
  it("until the scan is on: polls every 10 s for 5 minutes, prints no tag after 300 s, removes both, exits 1; prints no key", async () => {
    const r = await run(() => {});
    expect(r.code).toBe(1);
    expect(r.sleeps).toBe(30);
    expect(r.lines).toEqual(["clean: no tag after 300 s", "eicar: no tag after 300 s"]);
    expect(r.store.objects.size).toBe(0);
    for (const k of r.puts) expect(r.lines.join("\n")).not.toContain(k);
  });
  it("a wrong verdict (EICAR not caught) exits 1; settings missing is named, never a value", async () => {
    expect((await run((s, key) => s.tags.set(key, "NO_THREATS_FOUND"))).code).toBe(1);
    const lines: string[] = [];
    expect(await main({ FILES_S3_KEY_ID: "id-value" }, (l) => lines.push(l))).toBe(1);
    expect(lines).toEqual(["FAIL settings: file storage is off: FILES_S3_SECRET, FILES_S3_BUCKET, FILES_S3_REGION not set"]);
  });
});
