// Small fake files for the file tests: each type's signature, and a zip with a real central directory.
import { deflateRawSync } from "node:zlib";

export const b = (...xs: (number[] | string)[]) => new Uint8Array(Buffer.concat(xs.map((x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.from(x)))));
// A zip with the named entries (stored or deflated), with a real central directory.
export function zip(names: string[], deflate = false): Uint8Array {
  const locals: Buffer[] = [], dirs: Buffer[] = [];
  let off = 0;
  for (const name of names) {
    const raw = Buffer.from(`<x>${name}</x>`), data = deflate ? deflateRawSync(raw) : raw, n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(deflate ? 8 : 0, 8); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const d = Buffer.alloc(46); d.writeUInt32LE(0x02014b50, 0); d.writeUInt16LE(deflate ? 8 : 0, 10); d.writeUInt32LE(data.length, 20); d.writeUInt32LE(raw.length, 24); d.writeUInt16LE(n.length, 28); d.writeUInt32LE(off, 42);
    locals.push(l, n, data); dirs.push(d, n);
    off += 30 + n.length + data.length;
  }
  const dir = Buffer.concat(dirs), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(names.length, 8); e.writeUInt16LE(names.length, 10); e.writeUInt32LE(dir.length, 12); e.writeUInt32LE(off, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, e]));
}
export const PDF = b("%PDF-1.7\n%fake\n");
export const PNG = b([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "fake");
export const JPEG = b([0xff, 0xd8, 0xff, 0xe0], "fake");
export const WEBP = b("RIFF", [0x10, 0, 0, 0], "WEBPVP8 fake");
export const EXE = b("MZ", [0x90, 0], "fake program"); // a Windows program, whatever its name says
export const DOCX = zip(["[Content_Types].xml", "_rels/.rels", "word/document.xml"], true);
