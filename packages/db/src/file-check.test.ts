// No database: what an upload is (the bytes decide), the name label, and reading a multipart body with its cap. Hostile input included.
import { describe, expect, it } from "vitest";
import { checkUpload, cleanName, MAX_BODY, MAX_FILE, readUpload } from "./file-check";
import { b, DOCX, EXE, JPEG, PDF, PNG, WEBP, zip } from "./file-fixture";

const ALL = ["pdf", "docx", "jpeg", "png"] as const;

describe("checkUpload: the logo (P3)", () => {
  const LOGO = ["png", "jpeg", "webp"] as const;
  it("knows PNG, JPEG and WebP, with the 1 MB cap given", () => {
    expect(checkUpload(WEBP, LOGO, 1024 * 1024)).toEqual({ contentType: "webp" });
    expect(checkUpload(PNG, LOGO, 1024 * 1024)).toEqual({ contentType: "png" });
    const big = new Uint8Array(1024 * 1024 + 1); big.set(PNG);
    expect(checkUpload(big, LOGO, 1024 * 1024)).toEqual({ refused: "FILE_TOO_LARGE" });
    expect(checkUpload(big.subarray(0, 1024 * 1024), LOGO, 1024 * 1024)).toEqual({ contentType: "png" });
  });
  it("refuses a program, a PDF, a RIFF that is not WebP and a short RIFF", () => {
    for (const x of [EXE, PDF, DOCX, b("RIFF", [0, 0, 0, 0], "AVI LIST"), b("RIFF")]) expect(checkUpload(x, LOGO)).toEqual({ refused: "WRONG_FILE_TYPE" });
  });
});

describe("checkUpload: the bytes decide", () => {
  it("knows each type by its signature", () => {
    expect(checkUpload(PDF, ALL)).toEqual({ contentType: "pdf" });
    expect(checkUpload(DOCX, ALL)).toEqual({ contentType: "docx" });
    expect(checkUpload(zip(["word/document.xml", "[Content_Types].xml"]), ALL)).toEqual({ contentType: "docx" });
    expect(checkUpload(JPEG, ALL)).toEqual({ contentType: "jpeg" });
    expect(checkUpload(PNG, ALL)).toEqual({ contentType: "png" });
  });
  it("refuses a type not allowed on this route, whatever the bytes are", () => {
    expect(checkUpload(PNG, ["pdf", "docx"])).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(DOCX, ["pdf", "jpeg", "png"])).toEqual({ refused: "WRONG_FILE_TYPE" });
  });
  it("refuses empty and over 4 MB (4 MB exactly is fine)", () => {
    expect(checkUpload(new Uint8Array(), ALL)).toEqual({ refused: "EMPTY_FILE" });
    const big = new Uint8Array(MAX_FILE + 1); big.set(PDF);
    expect(checkUpload(big, ALL)).toEqual({ refused: "FILE_TOO_LARGE" });
    expect(checkUpload(big.subarray(0, MAX_FILE), ALL)).toEqual({ contentType: "pdf" });
    expect(MAX_FILE).toBe(4_194_304);
  });
  it("refuses a zip that is not a Word file, a damaged zip, and a zip signature with no directory", () => {
    expect(checkUpload(zip(["[Content_Types].xml", "xl/workbook.xml"]), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(zip(["word/document.xml"]), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    const cut = DOCX.subarray(0, DOCX.length - 30);
    expect(checkUpload(cut, ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(b([0x50, 0x4b, 0x03, 0x04], "x".repeat(40)), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    const lying = new Uint8Array(DOCX); new DataView(lying.buffer).setUint32(lying.length - 6, 1 << 30, true); // directory offset past the end
    expect(checkUpload(lying, ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
  });
  it("refuses an image that is HTML, a PDF signature not at byte 0, and text", () => {
    expect(checkUpload(b("<html><script>alert(1)</script></html>"), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(b(" %PDF-1.7"), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(b([0xef, 0xbb, 0xbf], "%PDF-1.7"), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(b("%PDF"), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
    expect(checkUpload(b([0xff, 0xd8]), ALL)).toEqual({ refused: "WRONG_FILE_TYPE" });
  });
});

describe("cleanName: a label only", () => {
  it("keeps a plain name", () => expect(cleanName("My CV 2026.pdf", "pdf", "cv")).toBe("My CV 2026.pdf"));
  it("keeps only the last path part, either slash", () => {
    expect(cleanName("../../etc/passwd.pdf", "pdf", "cv")).toBe("passwd.pdf");
    expect(cleanName("C:\\Users\\x\\scan.png", "png", "document")).toBe("scan.png");
  });
  it("removes control and format characters (a right-to-left override, zero width, new lines)", () => {
    expect(cleanName("inv\u202Efdp.exe\r\n.pdf", "pdf", "cv")).toBe("invfdp.exe.pdf");
    expect(cleanName("a\u200Bb\u0000.png", "png", "document")).toBe("ab.png");
  });
  it("an empty or dots-only name becomes the fallback with the extension", () => {
    expect(cleanName("", "pdf", "cv")).toBe("cv.pdf");
    expect(cleanName("../..", "docx", "cv")).toBe("cv.docx");
    expect(cleanName("\u0007\u200B", "jpeg", "document")).toBe("document.jpg");
    expect(cleanName(".pdf", "pdf", "cv")).toBe("cv.pdf");
  });
  it("adds the type's extension when the name says another type", () => {
    expect(cleanName("page.html", "pdf", "document")).toBe("page.html.pdf");
    expect(cleanName("photo.JPEG", "jpeg", "document")).toBe("photo.JPEG");
    expect(cleanName("cv", "docx", "cv")).toBe("cv.docx");
  });
  it("is at most 200 characters and keeps the extension", () => {
    const n = cleanName("é".repeat(500), "pdf", "cv");
    expect([...n].length).toBe(200);
    expect(n.endsWith(".pdf")).toBe(true);
    expect(cleanName(`${"x".repeat(300)}.PDF`, "pdf", "cv")).toBe(`${"x".repeat(196)}.PDF`);
    expect(cleanName(`${"x".repeat(300)}.html`, "png", "document")).toBe(`${"x".repeat(196)}.png`);
  });
});

const URL_ = "http://localhost:3000/api/x";
const form = (entries: [string, Blob | string, string?][]) => {
  const f = new FormData();
  for (const [k, v, n] of entries) if (typeof v === "string") f.append(k, v); else f.append(k, v, n);
  return f;
};
const req = (body: BodyInit, headers: Record<string, string> = {}) => new Request(URL_, { method: "POST", body, headers });

describe("readUpload: one field `file`, a byte cap", () => {
  it("reads the one file and its name", async () => {
    const r = await readUpload(req(form([["file", new Blob([PDF]), "a.pdf"]])));
    expect(r).toMatchObject({ name: "a.pdf" });
    expect(Buffer.from((r as { bytes: Uint8Array }).bytes).equals(Buffer.from(PDF))).toBe(true);
  });
  it("refuses a missing field, two files, a wrong field name, an extra field and a text field", async () => {
    for (const f of [form([]), form([["file", new Blob([PDF]), "a"], ["file", new Blob([PDF]), "b"]]), form([["cv", new Blob([PDF]), "a"]]),
      form([["file", new Blob([PDF]), "a"], ["note", "x"]]), form([["file", "%PDF-1.7"]])])
      expect(await readUpload(req(f))).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
  it("refuses a body that is not multipart, and a broken multipart body", async () => {
    expect(await readUpload(req(JSON.stringify({ file: "x" }), { "content-type": "application/json" }))).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(await readUpload(req("file=x", { "content-type": "application/x-www-form-urlencoded" }))).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(await readUpload(req("garbage", { "content-type": "multipart/form-data; boundary=zzz" }))).toEqual({ status: 400, code: "BAD_REQUEST" });
  });
  it("refuses by Content-Length before reading, and by counting when the header lies or is missing", async () => {
    let pulled = 0;
    const endless = new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)); } });
    const said = new Request(URL_, { method: "POST", body: endless, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=zzz", "content-length": String(MAX_BODY + 1) } } as RequestInit);
    expect(await readUpload(said)).toEqual({ status: 413, code: "FILE_TOO_LARGE" });
    expect(pulled).toBeLessThanOrEqual(1); // nothing read beyond what the stream had queued
    const silent = new Request(URL_, { method: "POST", body: endless, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=zzz" } } as RequestInit);
    expect(await readUpload(silent)).toEqual({ status: 413, code: "FILE_TOO_LARGE" });
    expect(pulled * 64 * 1024).toBeLessThan(MAX_BODY + 3 * 64 * 1024); // it stopped at the cap
  });
  it("time budget: a 4 MB upload is read and checked in under 500 ms", async () => {
    const big = new Uint8Array(MAX_FILE); big.set(PDF);
    const t0 = performance.now();
    const r = await readUpload(req(form([["file", new Blob([big]), "big.pdf"]])));
    expect(checkUpload((r as { bytes: Uint8Array }).bytes, ["pdf"])).toEqual({ contentType: "pdf" });
    const ms = performance.now() - t0;
    console.log(`file-check: 4 MB read and checked in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(500);
  });
});
