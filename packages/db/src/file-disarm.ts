// Disarm at upload (S-Q6): every stored copy another person may open passes here after checkUpload (file-check.ts). Images are decoded and
// re-encoded with sharp (all metadata dropped, a pixel limit, what does not decode is refused); the re-encoded bytes are what is stored. PDFs are
// refused when they carry active content, are encrypted, or hide objects behind a filter we cannot read. Standard library only for PDFs (U2).
import { inflateSync } from "node:zlib";
import type { Kind } from "./file-check";

export type DisarmRefusal = "FILE_ACTIVE_CONTENT" | "WRONG_FILE_TYPE" | "FILE_TOO_LARGE";
// 40 megapixels: a 48 MP phone photo in full mode is refused, the usual 12 MP and every scan at 300 dpi up to A3 (about 17 MP) pass.
// Decoded at 4 bytes a pixel that is at most 160 MB of memory, inside a 2 GB Vercel function.
export const MAX_PIXELS = 40_000_000;
// The total a PDF's object streams may inflate to: real object streams are kilobytes; a decompression bomb is refused.
export const MAX_INFLATE = 16 * 1024 * 1024;

const ACTIVE = /\/(?:JavaScript|JS|OpenAction|AA|Launch|EmbeddedFiles?|RichMedia|XFA|Encrypt)(?=[\s/<>[\]()%{}]|$)/;
const unescape = (s: string) => s.replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));

/** Why a PDF is refused, or null when it may be stored. Pure.
 *  Every byte outside streams is scanned, and so is every unfiltered stream that is not an image (a reader repairing a broken file scans raw
 *  bytes for objects). Only object streams (`/First` or `/Type /ObjStm`) can hold objects, so only they are inflated, under one total cap; an
 *  object stream with a filter other than plain FlateDecode is refused. Other compressed streams (page content, fonts, images) hold no objects. */
export function pdfRefusal(bytes: Uint8Array, maxInflate = MAX_INFLATE): DisarmRefusal | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!text.startsWith("%PDF-") || !text.slice(-1024).includes("%%EOF")) return "WRONG_FILE_TYPE"; // truncated: it cannot be checked whole
  const active = (s: string) => ACTIVE.test(unescape(s));
  let inflated = 0, at = 0;
  const streamAt = /stream\r?\n/g;
  for (let m; (m = streamAt.exec(text)); ) {
    if (/[A-Za-z]/.test(text[m.index - 1] ?? "")) continue; // "endstream" or a longer word
    const head = text.slice(at, m.index), start = m.index + m[0].length;
    if (active(head)) return "FILE_ACTIVE_CONTENT";
    const dict = unescape(head.slice(head.lastIndexOf("obj") + 1));
    const len = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let end = len ? start + Number(len[1]) : -1;
    if (end < 0 || end > text.length || !/^\s*endstream/.test(text.slice(end, end + 32))) end = text.indexOf("endstream", start);
    if (end < 0) return "WRONG_FILE_TYPE";
    at = streamAt.lastIndex = end;
    const holdsObjects = /\/First\b|\/Type\s*\/ObjStm\b/.test(dict);
    if (!/\/Filter\b/.test(dict)) {
      if ((holdsObjects || !/\/Subtype\s*\/Image\b/.test(dict)) && active(text.slice(start, end))) return "FILE_ACTIVE_CONTENT";
      continue;
    }
    if (!holdsObjects) continue;
    // ASCII85, LZW, a chain, an indirect filter or a predictor: not read here, so an object stream using one is not trusted
    if (!/\/Filter\s*(?:\/FlateDecode(?![^\s/<>[\]()%{}])|\[\s*\/FlateDecode\s*\])/.test(dict) || /\/Predictor\s+(?:[2-9]|\d\d)/.test(dict)) return "FILE_ACTIVE_CONTENT";
    let out: Buffer;
    try {
      out = inflateSync(Buffer.from(bytes.buffer, bytes.byteOffset + start, end - start), { maxOutputLength: Math.max(1, maxInflate - inflated) });
    } catch {
      return "FILE_ACTIVE_CONTENT"; // a bomb (over the cap) or a stream that does not inflate
    }
    inflated += out.length;
    if (active(out.toString("latin1"))) return "FILE_ACTIVE_CONTENT";
  }
  return active(text.slice(at)) ? "FILE_ACTIVE_CONTENT" : null;
}

type Sharp = typeof import("sharp").default;
let sharpModule: Promise<Sharp> | undefined;
// Loaded on first use, so an app that never re-encodes never loads the native module.
const loadSharp = () => (sharpModule ??= import("sharp").then((m) => { m.default.cache(false); return m.default; }));

/** The image decoded and re-encoded in its own format, with no metadata (EXIF orientation applied first); a refusal when it does not decode. */
export async function reencode(bytes: Uint8Array, kind: "png" | "jpeg" | "webp"): Promise<Uint8Array | DisarmRefusal> {
  const sharp = await loadSharp();
  try {
    const img = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error", animated: false }).rotate();
    return new Uint8Array(await (kind === "png" ? img.png() : kind === "jpeg" ? img.jpeg() : img.webp()).toBuffer());
  } catch {
    return "WRONG_FILE_TYPE"; // does not decode, or over the pixel limit
  }
}

/** The bytes to store, or why the file is refused. A DOCX passes unchanged (only CVs take DOCX; see the report). */
export async function disarm(bytes: Uint8Array, kind: Kind, max: number): Promise<{ bytes: Uint8Array } | { refused: DisarmRefusal }> {
  if (kind === "pdf") { const r = pdfRefusal(bytes); return r ? { refused: r } : { bytes }; }
  if (kind === "docx") return { bytes };
  const out = await reencode(bytes, kind);
  if (typeof out === "string") return { refused: out };
  return out.length > max ? { refused: "FILE_TOO_LARGE" } : { bytes: out };
}

// U3: does sharp load and work in this deployed function? Computed once per instance (the first health call), then reused. A boolean only.
let sharpCheck: Promise<boolean> | undefined;
export const sharpWorks = (): Promise<boolean> =>
  (sharpCheck ??= loadSharp()
    .then((s) => s({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).png().toBuffer())
    .then((b) => b.length > 0, () => false));
