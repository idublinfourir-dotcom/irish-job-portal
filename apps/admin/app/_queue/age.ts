// Times for the staff queues. The database sends `timestamptz::text` ("2026-11-24 10:42:00.123+00"); a page shows an age ("5 h") and a day and time in Dublin.
export function parse(text: string): Date {
  const iso = text.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  return new Date(iso);
}

/** How long ago, in the units the frames use: minutes under an hour, hours under two days, then days. A time in the future reads "0 min". */
export function ageText(text: string, now: Date): string {
  const s = Math.max(0, (now.getTime() - parse(text).getTime()) / 1000);
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}
export const ageSeconds = (s: number): string => ageText(new Date(0).toISOString(), new Date(s * 1000));

const DAY = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", day: "numeric", month: "short", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", hour: "2-digit", minute: "2-digit", hour12: false });
const WEEKDAY = new Intl.DateTimeFormat("en-IE", { timeZone: "Europe/Dublin", weekday: "long" });
/** "9 Nov 2026, 10:42" in Irish time. */
export const when = (text: string): string => { const d = parse(text); return `${DAY.format(d)}, ${TIME.format(d)}`; };
/** "10:58" in Irish time. */
export const clock = (text: string): string => TIME.format(parse(text));
/** "Monday 9 Nov 2026" in Irish time. */
export const today = (now: Date): string => `${WEEKDAY.format(now)} ${DAY.format(now)}`;
