import { fold } from "./prompt";
import type { ListEntry } from "./types";

export type Checked =
  | { ok: true; code: string; entry: ListEntry | null; confidence: "high" | "medium" | "low"; quote: string; quoteFound: boolean }
  | { ok: false; why: string };

const MAX_ANSWER = 20_000;
const MAX_QUOTE = 500;
const FIELDS = ["code", "confidence", "entry", "quote"];
const bad = (why: string): Checked => ({ ok: false, why });

/** Strict reading of the model's text. Reasons are fixed phrases that never repeat model text. */
export function checkAnswer(raw: string, entries: ReadonlyMap<string, ListEntry>, advertText: string): Checked {
  if (typeof raw !== "string" || raw.trim() === "") return bad("empty answer");
  if (raw.length > MAX_ANSWER) return bad("answer too long");
  const fenced = /^\s*```(?:json)?[ \t]*\n([\s\S]*?)\n?```\s*$/.exec(raw);
  let data: unknown;
  try {
    data = JSON.parse(fenced ? (fenced[1] as string) : raw);
  } catch {
    return bad("not JSON");
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return bad("not a JSON object");
  const o = data as Record<string, unknown>;
  if (Object.keys(o).sort().join() !== FIELDS.join()) return bad("fields are not exactly code, entry, confidence, quote");
  const { code, entry: id, confidence, quote } = o;
  if (typeof code !== "string" || typeof id !== "string" || typeof quote !== "string") return bad("a field is not a string");
  if (confidence !== "high" && confidence !== "medium" && confidence !== "low") return bad("confidence is not high, medium or low");
  if (quote.length > MAX_QUOTE) return bad("quote too long");
  if (code === "none") return id === "none" ? { ok: true, code, entry: null, confidence, quote, quoteFound: true } : bad("code is none but an entry was picked");
  if (!/^[0-9]{4}$/.test(code)) return bad("code is not four digits");
  let entry: ListEntry | null = null;
  if (id !== "none") {
    entry = entries.get(id) ?? null; // Map: an id like "__proto__" cannot reach the prototype
    if (!entry) return bad("entry id was not sent");
    if (entry.code !== code) return bad("code does not match its entry");
  }
  const q = fold(quote);
  return { ok: true, code, entry, confidence, quote, quoteFound: q !== "" && fold(advertText).includes(q) };
}
