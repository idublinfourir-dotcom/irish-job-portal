// What an uploaded file is, from its bytes only: the declared type and the name's extension are never trusted. Also the name cleaning and the
// reading of a multipart body with a byte cap (counted while reading, so a body that lies about its length is still cut off).
export type Kind = "pdf" | "docx" | "jpeg" | "png";
export const MIME: Record<Kind, string> = {
  pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", jpeg: "image/jpeg", png: "image/png",
};
const EXT: Record<Kind, string> = { pdf: "pdf", docx: "docx", jpeg: "jpg", png: "png" };
export const MAX_FILE = 4 * 1024 * 1024; // 4,194,304 bytes, under Vercel's 4.5 MB request limit
export const MAX_BODY = MAX_FILE + 16 * 1024; // the multipart wrapping (boundaries, headers, a 200-character name) is far under 16 kB
export type Refusal = "EMPTY_FILE" | "FILE_TOO_LARGE" | "WRONG_FILE_TYPE";

const starts = (b: Uint8Array, sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

// A .docx is a zip whose central directory names both parts. Only the directory is read; nothing is inflated.
function isDocx(b: Uint8Array): boolean {
  if (!starts(b, [0x50, 0x4b, 0x03, 0x04]) || b.length < 22) return false;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let end = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) return false;
  const names = new Set<string>();
  let at = v.getUint32(end + 16, true);
  for (let k = v.getUint16(end + 10, true); k > 0; k--) {
    if (at + 46 > b.length || v.getUint32(at, true) !== 0x02014b50) return false;
    const len = v.getUint16(at + 28, true);
    names.add(new TextDecoder().decode(b.subarray(at + 46, at + 46 + len)));
    at += 46 + len + v.getUint16(at + 30, true) + v.getUint16(at + 32, true);
  }
  return names.has("word/document.xml") && names.has("[Content_Types].xml");
}

const SNIFF: Record<Kind, (b: Uint8Array) => boolean> = {
  pdf: (b) => starts(b, ascii("%PDF-")),
  docx: isDocx,
  jpeg: (b) => starts(b, [0xff, 0xd8, 0xff]),
  png: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

export function checkUpload(bytes: Uint8Array, allowed: readonly Kind[]): { contentType: Kind } | { refused: Refusal } {
  if (bytes.length === 0) return { refused: "EMPTY_FILE" };
  if (bytes.length > MAX_FILE) return { refused: "FILE_TOO_LARGE" };
  const kind = allowed.find((k) => SNIFF[k](bytes));
  return kind ? { contentType: kind } : { refused: "WRONG_FILE_TYPE" };
}

/** The name as a label only: its last path part, no control or format characters, at most 200 characters, ending in the type's extension. */
export function cleanName(name: string, kind: Kind, fallback: "cv" | "document"): string {
  const s = (name.split(/[/\\]/).pop() ?? "").replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  const ext = `.${EXT[kind]}`;
  if (/^\.*$/.test(s)) return `${fallback}${ext}`;
  // The name's own extension when it matches the bytes, else the type's, so a saved copy never opens as another type (a PDF named page.html).
  const own = [ext, ...(kind === "jpeg" ? [".jpeg"] : [])].find((e) => s.toLowerCase().endsWith(e));
  const stem = [...(own ? s.slice(0, -own.length) : s)];
  if (!stem.length) return `${fallback}${ext}`;
  return stem.slice(0, 200 - (own ?? ext).length).join("") + (own ? s.slice(-own.length) : ext);
}

/** The one file of a multipart body (field `file`, nothing else), or a refusal code with its status. Reads at most MAX_BODY bytes. */
export async function readUpload(request: Request): Promise<{ name: string; bytes: Uint8Array } | { status: number; code: string }> {
  if (!/^multipart\/form-data;/i.test(request.headers.get("content-type") ?? "")) return { status: 400, code: "BAD_REQUEST" };
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return { status: 413, code: "FILE_TOO_LARGE" };
  const parts: Uint8Array[] = [];
  let size = 0;
  if (request.body) for await (const chunk of request.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.length;
    if (size > MAX_BODY) return { status: 413, code: "FILE_TOO_LARGE" }; // leaving the loop cancels the stream
    parts.push(chunk);
  }
  let form: FormData;
  try { form = await new Response(Buffer.concat(parts), { headers: { "content-type": request.headers.get("content-type")! } }).formData(); } catch { return { status: 400, code: "BAD_REQUEST" }; }
  const entries = [...form.entries()];
  const file = entries[0]?.[1];
  if (entries.length !== 1 || entries[0]![0] !== "file" || typeof file === "string" || !file) return { status: 400, code: "BAD_REQUEST" };
  return { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
