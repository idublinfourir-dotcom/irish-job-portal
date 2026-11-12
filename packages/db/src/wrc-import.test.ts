// Unit: reading the WRC list by word position, on a made-up list (as bbox text, and as a small real PDF through pdftotext). No database. Made-up agencies only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseWrc, pdfToBbox } from "./wrc-import";
import { wrcBbox, wrcPdf, type WrcLine } from "../test/registers-helpers";

const LINES: WrcLine[] = [
  { name: "Fake Recruit Limited", trading: "FakeHire", address: "1 Example Street Exampletown", licence: "EA4373", county: "Carlow" },
  { name: "Sample & Sons Staffing", address: "2 Sample Road Sampleville", licence: "EA 120", county: "Carlow" },
  { name: "Third Agency Ltd", trading: "Third", address: "3 Third Avenue", licence: "EA5001", county: "Dublin" },
];
const hasPdftotext = (() => { try { execFileSync("pdftotext", ["-v"], { stdio: "ignore" }); return true; } catch { return false; } })();

describe("parseWrc", () => {
  it("reads number, names, address and the county heading above each group; underscores mean no trading name", () => {
    const p = parseWrc(wrcBbox(LINES));
    expect(p).toMatchObject({ badNumbers: 0, duplicates: [] });
    expect(p.rows).toEqual([
      { licenceNumber: "EA4373", agencyName: "Fake Recruit Limited", tradingName: "FakeHire", address: "1 Example Street Exampletown", county: "Carlow" },
      { licenceNumber: "EA120", agencyName: "Sample & Sons Staffing", tradingName: null, address: "2 Sample Road Sampleville", county: "Carlow" },
      { licenceNumber: "EA5001", agencyName: "Third Agency Ltd", tradingName: "Third", address: "3 Third Avenue", county: "Dublin" },
    ]);
  });
  it("reports a repeated number (same agency or a different one) and keeps the first row", () => {
    const p = parseWrc(wrcBbox([...LINES, { ...LINES[0]!, county: "Dublin" }, { name: "Other Agency", address: "x", licence: "EA4373", county: "Dublin" }]));
    expect(p.rows).toHaveLength(3);
    expect(p.duplicates).toEqual(["EA4373 (same agency again)", "EA4373 (a different agency)"]);
  });
  it("counts a row with no readable number instead of crashing, and takes the longest digits when address digits sit at the same place", () => {
    const xml = wrcBbox(LINES).replace(">4373<", ">NOPE<").replace(">5001<", ">5001<");
    expect(parseWrc(xml)).toMatchObject({ badNumbers: 1 });
    const spill = wrcBbox(LINES).replace('</page>', '<word xMin="747.00" yMin="97.1" xMax="757.0" yMax="107.0">18</word></page>');
    expect(parseWrc(spill).rows.map((r) => r.licenceNumber)).toEqual(["EA4373", "EA120", "EA5001"]);
  });
  it("takes no instructions from the text: markup and odd characters stay plain text", () => {
    const p = parseWrc(wrcBbox([{ name: "Robert');DROP TABLE x;-- <b>Ltd</b>", address: "&#x3C;script&#x3E; \u0000 x", licence: "EA9", county: "Cork" }]));
    expect(p.rows[0]!.address).toBe("&#x3C;script&#x3E; x");
    expect(p.rows[0]!.agencyName).toContain("<b>Ltd</b>");
    expect(p.rows).toHaveLength(1);
  });
  it("an empty or unrelated text gives no rows", () => expect(parseWrc("<html>nothing</html>").rows).toEqual([]));
});

describe.skipIf(!hasPdftotext)("a real PDF through pdftotext", () => {
  it("reads the same rows from a small made-up PDF", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "wrc-unit-")), "list.pdf");
    writeFileSync(f, wrcPdf(LINES));
    const p = parseWrc(await pdfToBbox(f));
    expect(p.rows.map((r) => [r.licenceNumber, r.agencyName, r.tradingName, r.county])).toEqual(LINES.map((l) => [l.licence.replace(" ", ""), l.name, l.trading ?? null, l.county]));
  });
  it("refuses a file that is not a PDF", async () => {
    const f = join(mkdtempSync(join(tmpdir(), "wrc-unit-")), "bad.pdf");
    writeFileSync(f, "not a pdf");
    await expect(pdfToBbox(f)).rejects.toThrow(/pdftotext failed/);
  });
});
