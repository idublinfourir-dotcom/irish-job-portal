// Unit: disarm at upload (file-disarm.ts), the scan gate (files.ts) and the reserved address rule (outbox-cli.ts E2). No database, no network.
// The PDFs are built here (no binary fixtures from the internet). Time and memory budgets for the 4 MiB PDF check and a large image re-encode.
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { disarm, MAX_INFLATE, MAX_PIXELS, pdfRefusal, reencode, sharpWorks } from "./file-disarm";
import { JPEG, PDF, PNG, WEBP } from "./file-fixture";
import { MAX_FILE } from "./file-check";
import { scanGate } from "./files";
import { reservedAddress } from "./outbox-cli";

const buf = (...xs: (string | Buffer)[]) => new Uint8Array(Buffer.concat(xs.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : x))));
const CATALOG = "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj\n";
const pdf = (...body: (string | Buffer)[]) => buf("%PDF-1.7\n", CATALOG, ...body, "\ntrailer << /Root 1 0 R /Size 9 >>\n%%EOF\n");
/** An object stream holding `objects` (each "<< ... >>"), compressed with FlateDecode unless `filter` says otherwise. */
function objStm(objects: string[], o: { filter?: string; extra?: string; raw?: Buffer } = {}) {
  const offsets: number[] = [];
  let body = "";
  for (const x of objects) { offsets.push(body.length); body += `${x}\n`; }
  const head = objects.map((_, i) => `${10 + i} ${offsets[i]}`).join(" ") + "\n";
  const data = o.raw ?? deflateSync(Buffer.from(head + body, "latin1"));
  return Buffer.concat([Buffer.from(`5 0 obj << /Type /ObjStm /N ${objects.length} /First ${head.length} /Filter ${o.filter ?? "/FlateDecode"} ${o.extra ?? ""}/Length ${data.length} >>\nstream\n`, "latin1"),
    data, Buffer.from("\nendstream\nendobj\n", "latin1")]);
}
const NAMES = ["JavaScript", "JS", "OpenAction", "AA", "Launch", "EmbeddedFile", "EmbeddedFiles", "RichMedia", "XFA"];
const escaped = (n: string) => n.replace(/[a-z]/, (c) => `#${c.charCodeAt(0).toString(16)}`); // /J#61vaScript

describe("the PDF check (U2): standard library only", () => {
  it("passes a clean PDF, the fixture and a clean object stream with compressed content", () => {
    expect(pdfRefusal(PDF)).toBeNull();
    expect(pdfRefusal(pdf(objStm(["<< /Type /Page /Parent 2 0 R >>", "<< /Producer (Fake) >>"])))).toBeNull();
    const content = deflateSync(Buffer.from("BT /F1 12 Tf (Hello) Tj ET"));
    expect(pdfRefusal(pdf(`6 0 obj << /Filter /FlateDecode /Length ${content.length} >>\nstream\n`, content, "\nendstream\nendobj\n"))).toBeNull();
    // an image's bytes are not read (a JPEG stream may hold any bytes), only its dictionary
    expect(pdfRefusal(pdf("7 0 obj << /Type /XObject /Subtype /Image /Filter /DCTDecode /Length 8 >>\nstream\n/JS /AA \nendstream\nendobj\n"))).toBeNull();
  });
  it("refuses each active name in a plain object, inside a compressed object stream, and escaped", () => {
    for (const n of NAMES) {
      expect(pdfRefusal(pdf(`3 0 obj << /${n} 4 0 R >> endobj\n`)), `plain ${n}`).toBe("FILE_ACTIVE_CONTENT");
      expect(pdfRefusal(pdf(objStm([`<< /Type /Action /${n} (x) >>`]))), `object stream ${n}`).toBe("FILE_ACTIVE_CONTENT");
      expect(pdfRefusal(pdf(`3 0 obj << /${escaped(n)} 4 0 R >> endobj\n`)), `escaped ${escaped(n)}`).toBe("FILE_ACTIVE_CONTENT");
      expect(pdfRefusal(pdf(objStm([`<< /${escaped(n)} (x) >>`]))), `escaped in a stream ${n}`).toBe("FILE_ACTIVE_CONTENT");
    }
    expect(pdfRefusal(pdf("3 0 obj << /S /J#61vaScript /JS (app.alert(1)) >> endobj\n"))).toBe("FILE_ACTIVE_CONTENT");
    expect(pdfRefusal(pdf("6 0 obj << /Length 20 >>\nstream\n<< /OpenAction 9 0 R >>\nendstream\nendobj\n"))).toBe("FILE_ACTIVE_CONTENT"); // unfiltered stream text
    // names that only start the same are not refused
    expect(pdfRefusal(pdf("3 0 obj << /JSON 1 /AAB 2 /Launcher 3 >> endobj\n"))).toBeNull();
  });
  it("refuses an encrypted file, a bomb, a truncated file, and object streams it cannot read", () => {
    expect(pdfRefusal(pdf("trailer << /Encrypt 8 0 R >>\n"))).toBe("FILE_ACTIVE_CONTENT");
    const bomb = deflateSync(Buffer.alloc(MAX_INFLATE + 1024, 0x20)); // about 17 kB that inflates past the cap
    expect(bomb.length).toBeLessThan(50_000);
    expect(pdfRefusal(pdf(objStm(["<< >>"], { raw: bomb })))).toBe("FILE_ACTIVE_CONTENT");
    expect(pdfRefusal(pdf(objStm(["<< >>"], { raw: bomb.subarray(0, 4000) })), 1000)).toBe("FILE_ACTIVE_CONTENT"); // a small cap, a cut stream
    const whole = pdf(objStm(["<< /Type /Page >>"]));
    expect(pdfRefusal(whole.subarray(0, whole.length - 200))).toBe("WRONG_FILE_TYPE"); // truncated: no %%EOF
    expect(pdfRefusal(buf("%PDF-1.7\n6 0 obj << /Length 10 >>\nstream\nabc"))).toBe("WRONG_FILE_TYPE");
    expect(pdfRefusal(pdf(objStm(["<< /JS (x) >>"], { filter: "/ASCIIHexDecode", raw: Buffer.from("2F4A53>") })))).toBe("FILE_ACTIVE_CONTENT");
    expect(pdfRefusal(pdf(objStm(["<< >>"], { filter: "[/FlateDecode /ASCII85Decode]" })))).toBe("FILE_ACTIVE_CONTENT"); // a chain
    expect(pdfRefusal(pdf(objStm(["<< >>"], { filter: "9 0 R" })))).toBe("FILE_ACTIVE_CONTENT"); // an indirect filter
    expect(pdfRefusal(pdf(objStm(["<< >>"], { extra: "/DecodeParms << /Predictor 12 /Columns 4 >> " })))).toBe("FILE_ACTIVE_CONTENT");
    expect(pdfRefusal(pdf(objStm(["<< >>"], { raw: Buffer.from("not zlib at all") })))).toBe("FILE_ACTIVE_CONTENT");
    expect(pdfRefusal(pdf(objStm(["<< >>"], { filter: "[ /FlateDecode ]" })))).toBeNull();
  });
  it("a PDF and HTML polyglot: HTML first is not a PDF at all; a PDF holding HTML passes and is only ever served as application/pdf with nosniff", () => {
    expect(pdfRefusal(buf("<html><script>alert(1)</script></html>\n%PDF-1.7\n%%EOF\n"))).toBe("WRONG_FILE_TYPE");
    expect(pdfRefusal(pdf("% <html><script>alert(1)</script></html>\n"))).toBeNull(); // see staff-file-view.test.ts for the headers
  });
  it("budget: a 4 MiB PDF with 2,000 compressed object streams is checked in under 150 ms (21 ms measured 20 Nov 2026)", () => {
    const parts: Buffer[] = [];
    const filler = Buffer.alloc(1800, 0x41);
    for (let i = 0; i < 2000; i++) parts.push(objStm([`<< /Type /Page /N ${i} >>`]), Buffer.from(`6 0 obj << /Length ${filler.length} /Subtype /Image >>\nstream\n`), filler, Buffer.from("\nendstream\nendobj\n"));
    const big = pdf(...parts);
    expect(big.length).toBeGreaterThan(3.5 * 1024 * 1024);
    expect(big.length).toBeLessThanOrEqual(MAX_FILE);
    const t = performance.now();
    expect(pdfRefusal(big)).toBeNull();
    const ms = performance.now() - t;
    process.stdout.write(`pdf check, ${big.length} bytes, 2000 object streams: ${ms.toFixed(0)} ms\n`);
    expect(ms).toBeLessThan(150);
  });
});

/** A PNG header that claims `w` by `h` pixels, with one tiny data chunk (a pixel bomb: small file, huge decode). */
function pngClaiming(w: number, h: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(64))), chunk("IEND", Buffer.alloc(0))]));
}

describe("image re-encode with sharp", () => {
  it("the fixtures come back byte for byte (they are sharp's own output)", async () => {
    expect(await reencode(PNG, "png")).toEqual(PNG);
    expect(await reencode(JPEG, "jpeg")).toEqual(JPEG);
    expect(await reencode(WEBP, "webp")).toEqual(WEBP);
  });
  it("drops what rides along: a script appended to a PNG, and all metadata (EXIF, a comment)", async () => {
    const out = await reencode(buf(Buffer.from(PNG), "<script>alert(1)</script>"), "png") as Uint8Array;
    expect(Buffer.from(out).includes("script")).toBe(false);
    expect(out).toEqual(PNG);
    const tagged = await sharp(JPEG).withExif({ IFD0: { Copyright: "fake-secret-gps-53.34N" } }).jpeg().toBuffer();
    expect(tagged.includes("fake-secret-gps")).toBe(true);
    const clean = await reencode(new Uint8Array(tagged), "jpeg") as Uint8Array;
    expect(Buffer.from(clean).includes("fake-secret-gps")).toBe(false);
    expect((await sharp(clean).metadata()).exif).toBeUndefined();
  });
  it("refuses what does not decode and a pixel bomb (over 40,000,000 pixels)", async () => {
    expect(await reencode(buf(Buffer.from(PNG).subarray(0, 8), "fake"), "png")).toBe("WRONG_FILE_TYPE");
    expect(await reencode(buf(Buffer.from(JPEG).subarray(0, 4), "fake"), "jpeg")).toBe("WRONG_FILE_TYPE");
    expect(await reencode(pngClaiming(30_000, 30_000), "png")).toBe("WRONG_FILE_TYPE");
    expect(MAX_PIXELS).toBe(40_000_000);
  });
  it("disarm: the kind decides (a PDF checked, a DOCX unchanged, an image re-encoded and held to the cap)", async () => {
    expect(await disarm(PDF, "pdf", MAX_FILE)).toEqual({ bytes: PDF });
    expect(await disarm(pdf("3 0 obj << /JS (x) >> endobj\n"), "pdf", MAX_FILE)).toEqual({ refused: "FILE_ACTIVE_CONTENT" });
    const docx = buf("PK fake");
    expect(await disarm(docx, "docx", MAX_FILE)).toEqual({ bytes: docx });
    expect(await disarm(PNG, "png", 10)).toEqual({ refused: "FILE_TOO_LARGE" });
  });
  it("budget: a 36 megapixel JPEG re-encodes in under 1 s and under 400 MB more memory (158 ms, 233 MB measured 20 Nov 2026)", async () => {
    const big = await sharp({ create: { width: 6000, height: 6000, channels: 3, background: "#8a3" } }).jpeg().toBuffer();
    expect(big.length).toBeLessThan(MAX_FILE);
    const before = process.memoryUsage().rss;
    let peak = before;
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 5);
    const t = performance.now();
    const out = await reencode(new Uint8Array(big), "jpeg");
    const ms = performance.now() - t;
    clearInterval(timer);
    peak = Math.max(peak, process.memoryUsage().rss);
    expect(out).toBeInstanceOf(Uint8Array);
    process.stdout.write(`image re-encode, 36 MP JPEG: ${ms.toFixed(0)} ms, ${((peak - before) / 1e6).toFixed(0)} MB more memory\n`);
    expect(ms).toBeLessThan(1000);
    expect(peak - before).toBeLessThan(400e6);
  });
  it("sharpWorks (the health field, U3) is true here and computed once", async () => {
    const a = sharpWorks();
    expect(sharpWorks()).toBe(a);
    expect(await a).toBe(true);
  });
});

describe("the scan gate (S-Q7 A)", () => {
  it("only NO_THREATS_FOUND opens; no tag is pending; anything else is blocked", () => {
    expect(scanGate("NO_THREATS_FOUND")).toBe("ok");
    expect(scanGate(null)).toBe("pending");
    for (const t of ["THREATS_FOUND", "UNSUPPORTED", "ACCESS_DENIED", "FAILED", "", "no_threats_found", "NO_THREATS_FOUND "]) expect(scanGate(t), t).toBe("blocked");
  });
});

describe("reserved addresses (E2)", () => {
  it("the RFC 2606 and 6761 names are never sent to; real ones are", () => {
    for (const e of ["dev-admin@portal.invalid", "a@x.test", "a@b.example", "a@localhost", "a@x.localhost", "a@example.com", "a@mail.example.org", "a@EXAMPLE.NET", "a@x.test."])
      expect(reservedAddress(e), e).toBe(true);
    for (const e of ["a@gmail.com", "a@example.ie", "a@notexample.com", "a@test.ie", "a@invalid.ie", "a@examples.com"]) expect(reservedAddress(e), e).toBe(false);
  });
});
