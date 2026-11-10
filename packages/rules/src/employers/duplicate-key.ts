import { cleanEmployerName } from "./name";
import { pyRegex } from "./py-text";

// R22. Two different duplicate keys in the Python (PORT-MAP 5.4); each stays its own function.

/**
 * Python: prototype/classify.py:199. `key = url or (norm(employer), title.lower(), location.lower())`.
 * Python mixes a string and a tuple in one set; here the two kinds get different prefixes so they never collide.
 */
export function urlOrNameKey(job: { url: string; employer: string; title: string; location: string }): string {
  if (job.url) return "u:" + job.url;
  return "t:" + JSON.stringify([cleanEmployerName(job.employer), job.title.toLowerCase(), job.location.toLowerCase()]);
}

// Python: prototype/fetch_ats.py:5 (`IRL`, imported in run_day.py as BOARD_IRL). A third place list: it has
// blanchardstown and sandyford and lacks kerry, clare, mayo, cavan and many more.
const BOARD_IRL = pyRegex(
  String.raw`\b(ireland|dublin|cork|galway|limerick|shannon|waterford|kildare|meath|wicklow|athlone|sligo|kinsale|leixlip|clonmel|letterkenny|drogheda|dundalk|kilkenny|wexford|carlow|tralee|ennis|naas|swords|blanchardstown|sandyford)\b`,
  "i",
);

/** Python: prototype/step0/run_day.py:130-132 (`dedup_key`): cleaned name | title as lower-case words | first board place. */
export function nameTitlePlaceKey(employer: string | null, title: string | null, location: string | null): string {
  const place = BOARD_IRL.exec(location ?? "");
  return [
    cleanEmployerName(employer ?? ""),
    (title ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim(),
    place ? place[0].toLowerCase() : "",
  ].join("|");
}
