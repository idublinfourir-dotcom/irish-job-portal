// The reply format every app shares (docs/openapi, Conventions): ids as strings of digits, times as ISO 8601 in UTC with Z, and one opaque
// paging token for the lists that page by id alone. Pure, so unit tests cover it.
import { isTime, validId } from "./search";
import { QueueRefused } from "./admin-queue";

const ID_KEY = /^id$|Id$/;
const TIME_KEY = /(At|Until)$/;

/** An ISO 8601 time in UTC with Z, from Postgres text (`2026-11-18 09:30:00.123456+00`) or an ISO time with an offset. Milliseconds are kept, microseconds dropped. */
export const isoTime = (s: string) => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString();

/**
 * A reply in the shared format: under a key `id` or ending in `Id`, a number becomes a string of digits; under a key ending in `At` or `Until`, a
 * time string becomes ISO with Z (a date without a time is left alone). Walks arrays and objects; anything else is unchanged.
 * ponytail: goes by the key names the portal replies use; a new id or time field must follow them (the OpenAPI schema check catches one that does not).
 */
export function toWire(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) return v.map((x) => toWire(x, key));
  if (v instanceof Date) return v;
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toWire(x, k)]));
  if (typeof v === "number" && ID_KEY.test(key)) return String(v);
  if (typeof v === "string" && TIME_KEY.test(key) && isTime(v)) return isoTime(v);
  return v;
}

/** The lists that page by id alone; the name goes into the token, so one list's token is refused by another. */
export type IdList = "cases" | "owner_reassign" | "manual_jobs";
/** The paging token of a list ordered by id alone: `{ l, i }` as base64url, like the `{ t, i }` tokens of the time-ordered lists. */
export const encodeIdCursor = (list: IdList, id: string) => Buffer.from(JSON.stringify({ l: list, i: id })).toString("base64url");

/** The id inside this list's token from encodeIdCursor. Anything else (a forged or changed token, another list's token, a bad id) is QueueRefused("bad_cursor"). */
export function decodeIdCursor(list: IdList, token: unknown): string {
  const bad = new QueueRefused("bad_cursor");
  if (typeof token !== "string" || token.length > 200 || !/^[A-Za-z0-9_-]+$/.test(token)) throw bad;
  let o: unknown;
  try { o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch { throw bad; }
  if (o === null || typeof o !== "object" || Array.isArray(o) || Object.keys(o).join() !== "l,i" || (o as { l: unknown }).l !== list || !validId((o as { i: unknown }).i)) throw bad;
  return (o as { i: string }).i;
}
