import { fold } from "./prompt";
import type { ListEntry } from "./types";

export type Checked =
  | { ok: true; code: string; entry: ListEntry | null; confidence: "high" | "medium" | "low"; quote: string; quoteFound: boolean }
  | { ok: false; why: string };

const MAX_ANSWER = 20_000;
const MAX_QUOTE = 500;
const FIELDS = ["code", "confidence", "entry", "quote"];
// A quote also counts when a stretch of the advert differs from it by at most 20% of its words (a word added, missing or changed), so a slight
// rewording passes. A quote under 6 words must still be exact: it is too short to be proof. Words are letters and digits, lower case.
const CLOSE_MIN_WORDS = 6;
const CLOSE_MAX_DIFF = 0.2;
const bad = (why: string): Checked => ({ ok: false, why });

const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];

/**
 * Where the first close match of the quote ends in the advert, as a word index, or -1. Edit distance on words against any stretch of the
 * advert (the quote may start anywhere, so the stretch is about as long as the quote). One row of the table, so memory is the quote's size and
 * time is advert words times quote words: linear in the advert, and the quote is at most 500 characters.
 */
function closeMatchEnd(quote: string, advertText: string): number {
  const q = words(quote);
  if (q.length < CLOSE_MIN_WORDS) return -1;
  const a = words(advertText);
  const limit = Math.floor(q.length * CLOSE_MAX_DIFF);
  let col = Int32Array.from({ length: q.length + 1 }, (_, i) => i); // col[i]: best distance of the first i quote words, ending at the last advert word read
  let next = new Int32Array(q.length + 1);
  for (let j = 0; j < a.length; j++) {
    const w = a[j];
    next[0] = 0; // a stretch may start at any advert word
    for (let i = 1; i <= q.length; i++) {
      const diag = col[i - 1]! + (q[i - 1] === w ? 0 : 1);
      const side = Math.min(col[i]!, next[i - 1]!) + 1;
      next[i] = diag < side ? diag : side;
    }
    if (next[q.length]! <= limit) return j;
    [col, next] = [next, col];
  }
  return -1;
}

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
  return { ok: true, code, entry, confidence, quote, quoteFound: q !== "" && (fold(advertText).includes(q) || closeMatchEnd(quote, advertText) >= 0) };
}
