// The hash of an advert's text (design 3.8) and the day rule for handing a known id back with its text.
import { createHash } from "node:crypto";
import type { RawAdvert } from "@portal/sources";

const sha = (s: string) => createHash("sha256").update(s);

/** SHA-256 hex of the six fields as a JSON array, so no choice of field text can run one field into the next. */
export const hashAdvert = (a: RawAdvert): string =>
  sha(JSON.stringify([a.title, a.employer, a.location, a.description, a.employmentType, a.salaryBox])).digest("hex");

/** An id is due on one day in `days`: a fixed number made from the id, against the day number (UTC). `days` unset or 0: never. */
export const isDue = (id: string, days: number | undefined, now: Date): boolean =>
  !!days && days > 0 && sha(id).digest().readUInt32BE(0) % days === Math.floor(now.getTime() / 86_400_000) % days;
