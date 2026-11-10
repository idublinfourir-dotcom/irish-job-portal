import { createHash } from "node:crypto";
import type { AdvertInput } from "@portal/rules";

export type Label = { qualifies: boolean; occupationCode: string; note: string };
export type TestAdvert = { id: string; advert: AdvertInput; label: Label };

export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The frozen hash file holds the hex digest, optionally followed by a file name (the `sha256sum` layout). */
export function checkFrozen(setBytes: string | Uint8Array, frozenText: string): string {
  const frozen = /^[0-9a-f]{64}\b/i.exec(frozenText.trim())?.[0]?.toLowerCase();
  if (!frozen) throw new Error("the frozen hash file does not start with a 64 character SHA-256");
  const actual = sha256(setBytes);
  if (actual !== frozen) throw new Error(`the test set does not match its frozen hash (set ${actual.slice(0, 12)}..., frozen ${frozen.slice(0, 12)}...). It was changed after it was frozen.`);
  return actual;
}

const ADVERT_FIELDS = ["id", "source", "board", "employer", "title", "location", "description", "url", "employmentType", "salaryBox"];

/** Errors name the line and the problem only, never the advert text. */
export function parseTestSet(text: string): TestAdvert[] {
  const out: TestAdvert[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `test set line ${i + 1}`;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line);
    } catch {
      throw new Error(`${where}: not JSON`);
    }
    const { id, advert, label } = row as { id?: unknown; advert?: Record<string, unknown>; label?: Record<string, unknown> };
    if (typeof id !== "string" || !id) throw new Error(`${where}: id must be a non-empty string`);
    if (seen.has(id)) throw new Error(`${where}: id ${id} is used twice`);
    seen.add(id);
    if (!advert || typeof advert !== "object" || typeof advert.source !== "string") throw new Error(`${where} (${id}): advert needs a string "source"`);
    for (const [k, v] of Object.entries(advert)) {
      if (!ADVERT_FIELDS.includes(k)) throw new Error(`${where} (${id}): unknown advert field "${k}"`);
      if (v !== null && typeof v !== "string") throw new Error(`${where} (${id}): advert field "${k}" must be a string or null`);
    }
    if (!label || typeof label.qualifies !== "boolean" || typeof label.occupationCode !== "string" || typeof label.note !== "string") {
      throw new Error(`${where} (${id}): label needs qualifies (true or false), occupationCode (text) and note (text)`);
    }
    out.push({ id, advert: advert as AdvertInput, label: label as Label });
  });
  return out;
}
