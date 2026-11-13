// Test helper (imported by tests only): builds tiny .xlsx files and hostile zips in memory. Fake data only.
import { crc32, deflateRawSync } from "node:zlib";

export type Entry = string | Buffer | { data: string | Buffer; usize?: number; crc?: number; flags?: number };

/** A zip of the entries, deflated, with the stated size, checksum or flags overridable per entry. */
export function makeZip(entries: Record<string, Entry>): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, e] of Object.entries(entries)) {
    const o = typeof e === "string" || Buffer.isBuffer(e) ? { data: e } : e;
    const raw = Buffer.from(o.data);
    const packed = deflateRawSync(raw);
    const nameBuf = Buffer.from(name);
    const head = (sig: number, extra: number) => {
      const b = Buffer.alloc(extra);
      b.writeUInt32LE(sig, 0);
      return b;
    };
    const l = head(0x04034b50, 30);
    l.writeUInt16LE(o.flags ?? 0, 6);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(o.crc ?? crc32(raw), 14);
    l.writeUInt32LE(packed.length, 18);
    l.writeUInt32LE(o.usize ?? raw.length, 22);
    l.writeUInt16LE(nameBuf.length, 26);
    locals.push(l, nameBuf, packed);
    const c = head(0x02014b50, 46);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    l.copy(c, 8, 6, 30); // flags to extra length have the same layout in both headers
    c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += l.length + nameBuf.length + packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const letters = (i: number) => String.fromCharCode(65 + i);

/** A one-sheet workbook. Strings go to the shared string table like Excel writes them; null leaves a cell out. `extra` adds or replaces parts. */
export function makeXlsx(rows: (string | number | null)[][], extra: Record<string, Entry> = {}): Buffer {
  const strings: string[] = [];
  const sheetRows = rows.map((r, ri) => {
    const cells = r.map((v, ci) => {
      if (v === null) return "";
      const ref = `${letters(ci)}${ri + 1}`;
      if (typeof v === "number") return `<c r="${ref}"><v>${v}</v></c>`;
      strings.push(v);
      return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
    });
    return `<row r="${ri + 1}">${cells.join("")}</row>`;
  });
  return makeZip({
    "[Content_Types].xml": "<Types/>",
    "xl/workbook.xml": '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/sharedStrings.xml": `<sst>${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("")}</sst>`,
    "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${sheetRows.join("")}</sheetData></worksheet>`,
    ...extra,
  });
}

/** A company sheet in the 2026 layout: employer in column A, month columns, then "Permits Issued Grand Total". `companies` is [name, total]. */
export function companiesXlsx(companies: [string, number | string][]): Buffer {
  return makeXlsx([
    ["Employer Name", "Permits Issued Jan", "Permits Issued Feb", "Permits Issued Grand Total"],
    ["Total", null, null, companies.reduce((n, [, p]) => n + (typeof p === "number" ? p : 0), 0)],
    ...companies.map(([n, p]): (string | number | null)[] => [n, null, null, p]),
  ]);
}
