// A small .xlsx reader on Node's own zlib (no dependency): the first worksheet as sparse rows of strings and numbers.
// Hostile input is refused whole with XlsxRefused: not a zip, encrypted or zip64, a part over the size cap (declared or actual),
// a wrong checksum or length, a bad shared-string index, a number that is not a number. Only the four parts it needs are inflated.
import { crc32, inflateRawSync } from "node:zlib";

export class XlsxRefused extends Error {}
export type Cell = string | number;
export type Row = { n: number; cells: Map<number, Cell> }; // n is the sheet's row number, cells are keyed by column index from 0

export const MAX_PART = 48 * 1024 * 1024; // the biggest real sheet is 3.2 MB
const MAX_ENTRIES = 1000;

const refuse = (why: string): never => {
  throw new XlsxRefused(`not a readable .xlsx file: ${why}`);
};

/** The named parts of a zip, inflated. A missing part is absent from the result. */
function unzip(buf: Buffer, wanted: Set<string>): Map<string, Buffer> {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) refuse("it is not a zip file");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) refuse("no zip directory");
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || at === 0xffffffff) refuse("zip64 is not supported");
  if (count > MAX_ENTRIES) refuse(`more than ${MAX_ENTRIES} entries`);
  const out = new Map<string, Buffer>();
  for (let k = 0; k < count; k++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) refuse("the zip directory is damaged");
    const flags = buf.readUInt16LE(at + 8), method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16);
    const csize = buf.readUInt32LE(at + 20), usize = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32), local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    if (!wanted.has(name)) continue;
    if (flags & 1) refuse("it is encrypted");
    if (usize > MAX_PART) refuse(`${name} is over ${MAX_PART} bytes`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) refuse("the zip directory is damaged");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) refuse("the zip is cut short");
    const data = buf.subarray(start, start + csize);
    let part: Buffer;
    if (method === 0) part = data;
    else if (method === 8) {
      try { part = inflateRawSync(data, { maxOutputLength: Math.max(usize, 1) }); } catch { return refuse(`${name} does not inflate to its stated size`); }
    } else return refuse("unknown compression");
    if (part.length !== usize || crc32(part) !== crc) refuse(`${name} fails its size or checksum`);
    out.set(name, part);
  }
  return out;
}

const decode = (s: string) =>
  s
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))) // Excel's escape for characters XML cannot hold
    .replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
      if (e[0] !== "#") return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[e]!;
      const cp = e[1] === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "\ufffd"; // refused later as a control character
    });
const text = (xml: string) => decode([...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").matchAll(/<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g)].map((m) => m[1] ?? "").join(""));
const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];
const column = (ref: string) => [...ref.replace(/\d+$/, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** The first worksheet of an .xlsx file. Regex based, for the plain files Excel writes; anything it cannot make sense of is refused. */
export function readXlsx(buf: Buffer): Row[] {
  const parts = unzip(buf, new Set(["xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/sharedStrings.xml", ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => `xl/worksheets/sheet${i}.xml`)]));
  const book = parts.get("xl/workbook.xml")?.toString("utf8");
  const rels = parts.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!book || !rels) return refuse("no workbook");
  const rid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(book)?.[1];
  const rel = [...rels.matchAll(/<Relationship\b([^>]*)>/g)].find((m) => attr(m[1]!, "Id") === rid);
  const target = rel && attr(rel[1]!, "Target")?.replace(/^\/?(xl\/)?/, "xl/");
  const sheet = target && parts.get(target)?.toString("utf8");
  if (!sheet) return refuse("no first worksheet");
  const shared = [...(parts.get("xl/sharedStrings.xml")?.toString("utf8") ?? "").matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)].map((m) => text(m[1] ?? ""));
  const rows: Row[] = [];
  let rowNo = 0;
  for (const r of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    rowNo = Number(attr(r[1]!, "r") ?? rowNo + 1);
    const cells = new Map<number, Cell>();
    let col = -1;
    for (const c of (r[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1]!, "r");
      col = ref ? column(ref) : col + 1;
      const type = attr(c[1]!, "t");
      const body = c[2] ?? "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (type === "inlineStr") cells.set(col, text(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? ""));
      else if (v === undefined || v === "") continue;
      else if (type === "s") cells.set(col, shared[Number(v)] ?? refuse(`row ${rowNo} points at a text that does not exist`));
      else if (type === undefined || type === "n") {
        const num = Number(v);
        if (!Number.isFinite(num)) refuse(`row ${rowNo} has a number that is not a number: "${v}"`);
        cells.set(col, num);
      } else cells.set(col, decode(v));
    }
    rows.push({ n: rowNo, cells });
  }
  return rows;
}
