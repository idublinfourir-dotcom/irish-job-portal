// Dates written out ("14 Oct 2026"), on the Irish calendar day, with no locale month names (some engines write "Sept"). A bad value comes back as null.
import { shortDate } from "../_home/format";

const DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit" }); // en-CA writes 2026-10-14
/** The Irish calendar day of a moment, as "14 Oct 2026". */
export function dublinDay(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : shortDate(DAY.format(t));
}
/** A stored day ("2026-11-12") written out; null when there is none. */
export const dayText = (day: string | null | undefined) => (day ? shortDate(day) : null);
