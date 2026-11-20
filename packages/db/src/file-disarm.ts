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

// A small forward reader of PDF syntax (ISO 32000 7.2 and 7.3): comments, literal strings (nested parentheses, backslash escapes), hex
// strings, names, numbers, arrays and dictionaries, so a stream's dictionary is the real one, not text that only looks like it.
type V = { k: "name"; v: string } | { k: "num"; v: number } | { k: "kw"; v: string } | { k: "str" } | { k: "arr"; items: V[] } | { k: "dict"; map: Map<string, V> } | { k: "ref" };
class Unsafe extends Error {}
const WS = new Set(["\0", "\t", "\n", "\f", "\r", " "]);
const DELIM = new Set(["(", ")", "<", ">", "[", "]", "{", "}", "/", "%"]);
const MAX_DEPTH = 64;

/** Past whitespace and comments. A comment that ends in "stream" could start a stream for a reader that jumps there by offset: refused. */
function skip(s: string, i: number): number {
  for (;;) {
    while (i < s.length && WS.has(s[i]!)) i++;
    if (s[i] !== "%") return i;
    let j = i;
    while (j < s.length && s[j] !== "\n" && s[j] !== "\r") j++;
    if (/stream\s*$/.test(s.slice(i, j))) throw new Unsafe();
    i = j;
  }
}

/** Pairs of a dictionary's items: a name key, then its value (`n g R` is one value, a reference). */
function pairs(items: V[]): Map<string, V> {
  const map = new Map<string, V>();
  for (let k = 0; k < items.length; ) {
    const key = items[k]!;
    if (key.k !== "name") { k++; continue; }
    const a = items[k + 1], b = items[k + 2], r = items[k + 3];
    if (a?.k === "num" && b?.k === "num" && r?.k === "kw" && r.v === "R") { map.set(key.v, { k: "ref" }); k += 4; } else { if (a) map.set(key.v, a); k += 2; }
  }
  return map;
}

/** One object at `i` (not past whitespace): the value and where it ends. Throws Unsafe on what a reader could read another way. */
function parse(s: string, i: number, depth: number): [V, number] {
  if (depth > MAX_DEPTH) throw new Unsafe();
  const c = s[i]!;
  if (c === "(") {
    let d = 0, j = i;
    for (; j < s.length; j++) {
      const x = s[j];
      if (x === "\\") { j++; continue; }
      if (x === "(") d++;
      else if (x === ")" && --d === 0) break;
    }
    if (j >= s.length || /stream\r?\n/.test(s.slice(i, j))) throw new Unsafe(); // unterminated, or a stream keyword hidden in a string
    return [{ k: "str" }, j + 1];
  }
  if (c === "<" && s[i + 1] === "<") {
    const items: V[] = [];
    for (let j = i + 2; ; ) {
      j = skip(s, j);
      if (j >= s.length) throw new Unsafe();
      if (s[j] === ">" && s[j + 1] === ">") return [{ k: "dict", map: pairs(items) }, j + 2];
      const [v, e] = parse(s, j, depth + 1);
      items.push(v);
      j = e;
    }
  }
  if (c === "<") {
    const j = s.indexOf(">", i);
    if (j < 0 || !/^[0-9A-Fa-f\s]*$/.test(s.slice(i + 1, j))) throw new Unsafe();
    return [{ k: "str" }, j + 1];
  }
  if (c === "[") {
    const items: V[] = [];
    for (let j = i + 1; ; ) {
      j = skip(s, j);
      if (j >= s.length) throw new Unsafe();
      if (s[j] === "]") return [{ k: "arr", items }, j + 1];
      const [v, e] = parse(s, j, depth + 1);
      items.push(v);
      j = e;
    }
  }
  if (c === "/") {
    let j = i + 1;
    while (j < s.length && !WS.has(s[j]!) && !DELIM.has(s[j]!)) j++;
    return [{ k: "name", v: unescape(s.slice(i + 1, j)) }, j];
  }
  if (DELIM.has(c)) return [{ k: "kw", v: c }, i + 1]; // a stray ) ] > { }
  let j = i;
  while (j < s.length && !WS.has(s[j]!) && !DELIM.has(s[j]!)) j++;
  const t = s.slice(i, j);
  return [/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t) ? { k: "num", v: Number(t) } : { k: "kw", v: t }, j];
}

const isName = (v: V | undefined, name: string) => v?.k === "name" && v.v === name;
const predicted = (p: V | undefined): boolean =>
  p === undefined ? false : p.k === "dict" ? ((x) => x !== undefined && (x.k !== "num" || x.v >= 2))(p.map.get("Predictor")) : p.k === "arr" ? p.items.some((x) => x.k !== "dict" || predicted(x)) : true;

/** Why a PDF is refused, or null when it may be stored. Pure.
 *  The file is read front to back with the reader above; every byte outside streams is scanned for the active names. A stream's dictionary is the
 *  top-level dictionary right before its `stream` keyword, read by its own keys only. The raw bytes of every stream are refused when they hold an
 *  object header or `endobj` (a reader finds objects by xref offset, or by scanning raw bytes, so objects hidden inside stream data count). Every
 *  unfiltered stream that is not an image is scanned as well. Only object streams (`/Type /ObjStm` or a `/First` key, whatever the `/Subtype`)
 *  can hold objects, so only they are inflated, under one total cap; one with a filter other than plain FlateDecode is refused. */
export function pdfRefusal(bytes: Uint8Array, maxInflate = MAX_INFLATE): DisarmRefusal | null {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!text.startsWith("%PDF-") || !text.slice(-1024).includes("%%EOF")) return "WRONG_FILE_TYPE"; // truncated: it cannot be checked whole
  const active = (s: string) => ACTIVE.test(unescape(s));
  let inflated = 0, outsideFrom = 0;
  let last: { map: Map<string, V>; end: number } | null = null;
  try {
    for (let i = skip(text, 0); i < text.length; i = skip(text, i)) {
      const [v, end] = parse(text, i, 0);
      if (v.k === "dict") { last = { map: v.map, end }; i = end; continue; }
      i = end;
      if (v.k !== "kw" || v.v !== "stream") continue;
      const eol = /^\r?\n/.exec(text.slice(end, end + 2));
      if (!eol || !last || !/^[\0\t\n\f\r ]*$/.test(text.slice(last.end, end - "stream".length))) throw new Unsafe(); // a stream with no dictionary of its own
      const dict = last.map, start = end + eol[0].length;
      last = null;
      const len = dict.get("Length");
      let stop = len?.k === "num" ? start + len.v : -1;
      if (stop < start || stop > text.length || !/^\s*endstream/.test(text.slice(stop, stop + 32))) stop = text.indexOf("endstream", start);
      if (stop < 0) return "WRONG_FILE_TYPE";
      if (active(text.slice(outsideFrom, start))) return "FILE_ACTIVE_CONTENT";
      outsideFrom = i = stop;
      const raw = text.slice(start, stop);
      if (/\d+\s+\d+\s+obj\b/.test(raw) || raw.includes("endobj")) return "FILE_ACTIVE_CONTENT"; // objects hidden in stream data
      const holdsObjects = isName(dict.get("Type"), "ObjStm") || dict.has("First");
      const filter = dict.get("Filter");
      if (!filter) {
        if ((holdsObjects || !isName(dict.get("Subtype"), "Image")) && active(raw)) return "FILE_ACTIVE_CONTENT";
        continue;
      }
      if (!holdsObjects) continue;
      // ASCII85, LZW, a chain, an indirect filter or a predictor: not read here, so an object stream using one is not trusted
      const flate = isName(filter, "FlateDecode") || (filter.k === "arr" && filter.items.length === 1 && isName(filter.items[0], "FlateDecode"));
      if (!flate || predicted(dict.get("DecodeParms"))) return "FILE_ACTIVE_CONTENT";
      let out: Buffer;
      try {
        out = inflateSync(Buffer.from(bytes.buffer, bytes.byteOffset + start, stop - start), { maxOutputLength: Math.max(1, maxInflate - inflated) });
      } catch {
        return "FILE_ACTIVE_CONTENT"; // a bomb (over the cap) or a stream that does not inflate
      }
      inflated += out.length;
      if (active(out.toString("latin1"))) return "FILE_ACTIVE_CONTENT";
    }
  } catch (e) {
    if (e instanceof Unsafe) return "FILE_ACTIVE_CONTENT";
    throw e;
  }
  return active(text.slice(outsideFrom)) ? "FILE_ACTIVE_CONTENT" : null;
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
