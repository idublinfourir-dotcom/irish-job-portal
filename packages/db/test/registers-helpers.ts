// Fake outside files for the register importer tests: a zip with a CSV in it, and the WRC list as bbox text or as a small real PDF. Made-up data only.
import { crc32, deflateRawSync } from "node:zlib";

export type ZipEntry = { name: string; data: Buffer | string; method?: 0 | 8; declaredSize?: number; flags?: number };

/** A zip file in memory (no zip64). `declaredSize` writes a wrong uncompressed size, to test the size guard. */
export function makeZip(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data);
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name);
    const plain = e.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.flags ?? 0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(plain, 22);
    local.writeUInt16LE(name.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(e.flags ?? 0, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(plain, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(dir, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

export const CRO_HEADER = "company_num,company_name,company_status_code,company_status,company_type_code,company_type,company_reg_date,last_ar_date,company_address_1,company_address_2,company_address_3,company_address_4,comp_dissolved_date,nard,last_accounts_date,company_status_date,nace_v2_code,eircode,company_name_eff_date,company_type_eff_date,princ_object_code";
export type CroLine = { num: string; name: string; status?: string; type?: string; address?: string[]; statusDate?: string };
const quote = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s);
/** One CSV line in the real file's column order. */
export function croLine(l: CroLine): string {
  const a = l.address ?? ["1 Example Street", "Exampletown", "Co. Cork", ""];
  const cells = [l.num, l.name, "1151", l.status ?? "Normal ", "1153", l.type ?? "LTD - Private Company Limited by Shares", "2020-01-31", "2026-01-31", a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "", "", "2027-01-31", "2025-12-31", l.statusDate ?? "2020-01-31", "5610.0", "A00A0A0", "2020-01-31", "2020-01-31", "74.84"];
  return cells.map(quote).join(",");
}
export const croCsv = (lines: CroLine[]) => [CRO_HEADER, ...lines.map(croLine)].join("\n") + "\n";
export const croZip = (lines: CroLine[]) => makeZip([{ name: "companies.csv", data: croCsv(lines) }]);

// ===== the WRC list: rows at the real file's column positions =====
export type WrcLine = { name: string; trading?: string; address: string; licence: string; county?: string };
type W = { x: number; y: number; text: string };
/** Words of a made-up list page, laid out like the real one: county headings at x 53, then one line per agency, 15.3 points apart. */
export function wrcWords(lines: WrcLine[]): W[] {
  const words: W[] = [];
  let y = 80;
  let county: string | undefined;
  const put = (x: number, yy: number, text: string) => text.split(" ").forEach((t, i) => words.push({ x: x + i * 40, y: yy, text: t }));
  for (const l of lines) {
    if (l.county && l.county !== county) {
      county = l.county;
      put(53, (y += 15.3), l.county);
    }
    y += 15.3;
    put(103, y + 1.8, l.name);
    put(317, y, l.trading ?? "______________");
    put(493, y + 1.8, l.address);
    words.push({ x: 733.3, y: y + 1.8, text: "EA" }, { x: 747, y: y + 1.8, text: l.licence.replace(/^EA\s*/, "") });
  }
  return words;
}
const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
/** The text `pdftotext -bbox` would print for these lines. */
export const wrcBbox = (lines: WrcLine[]): string =>
  `<doc>\n<page width="841.8" height="595.2">\n${wrcWords(lines).map((w) => `<word xMin="${w.x.toFixed(2)}" yMin="${w.y.toFixed(2)}" xMax="${(w.x + 5.2 * w.text.length).toFixed(2)}" yMax="${(w.y + 9.7).toFixed(2)}">${esc(w.text)}</word>`).join("\n")}\n</page>\n</doc>`;
/** A real, small PDF with the same words, so the pdftotext step is tested too. */
export function wrcPdf(lines: WrcLine[]): Buffer {
  const text = wrcWords(lines).map((w) => `BT /F1 8 Tf ${w.x.toFixed(1)} ${(595.2 - w.y - 8).toFixed(1)} Td (${w.text.replace(/[()\\]/g, "")}) Tj ET`).join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 841.8 595.2] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(text)} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at: number[] = [];
  objs.forEach((o, i) => ((at[i] = Buffer.byteLength(out)), (out += `${i + 1} 0 obj\n${o}\nendobj\n`)));
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}

// Typed or register spelling -> the key both the JS and the SQL name rule must give.
export const NAME_CASES: [string, string][] = [
  ["ACME LIMITED", "acme"], ["Acme Ltd.", "acme"], ["acme", "acme"], ["Acme & Sons Ltd", "acme and sons"], ["Acme and Sons Limited", "acme and sons"],
  ["Ó Briain Teoranta", "o briain"], ["Fáilte DAC", "failte"], ["Big  Co   CLG", "big co"], ["Fake Designated Activity Company", "fake"],
  ["Ltd", "ltd"], ["Limited Limited", "limited"], ["Acme Ltd Limited", "acme"], ["Ltd Services Ltd", "ltd services"], ["  --  ", ""], ["Acme (Cork) Ltd", "acme cork"],
  ["O'Neill's Plc", "o neill s"], ["Fake 24 Ltd", "fake 24"], ["Robert'); DROP TABLE cro_company;-- Ltd", "robert drop table cro company"],
];

