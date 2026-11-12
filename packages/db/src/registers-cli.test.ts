// Unit: the command's arguments and how it finds the CRO file, with a fake fetch. No network, no database.
import { describe, expect, it } from "vitest";
import { croZipUrl, main } from "./registers-cli";

const json = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("croZipUrl", () => {
  it("takes the zip from the dataset description, not a fixed address", async () => {
    const get = json({ result: { resources: [{ url: "https://opendata.cro.ie/x/readme.html", format: "HTML" }, { url: "https://opendata.cro.ie/a/b/companies.csv.zip", format: "CSV" }] } });
    expect(await croZipUrl(get)).toBe("https://opendata.cro.ie/a/b/companies.csv.zip");
  });
  it.each([["no zip", { result: { resources: [{ url: "https://x.test/a.html" }] } }], ["a changed shape", { nothing: true }], ["a plain http address", { result: { resources: [{ url: "http://x.test/a.zip" }] } }]])("refuses %s", async (_, body) => {
    await expect(croZipUrl(json(body))).rejects.toThrow();
  });
  it("refuses a failed answer", async () => {
    await expect(croZipUrl(json({}, 503))).rejects.toThrow(/503/);
  });
});

describe("main", () => {
  const lines: string[] = [];
  const log = (l: string) => void lines.push(l);
  it("prints usage for a wrong command or a --file with no path", async () => {
    expect(await main(["nope"], {}, log)).toBe(2);
    expect(await main(["wrc", "--file"], {}, log)).toBe(2);
  });
  it("needs the right login for each command", async () => {
    expect(await main(["cro"], { WRC_ADMIN_DATABASE_URL: "x" }, log)).toBe(2);
    expect(await main(["wrc"], { FETCHER_DATABASE_URL: "x" }, log)).toBe(2);
    expect(lines.join("\n")).toMatch(/FETCHER_DATABASE_URL is not set[\s\S]*WRC_ADMIN_DATABASE_URL is not set/);
  });
});
