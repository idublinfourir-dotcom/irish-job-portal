// Moved from packages/fetcher/src/county.ts (D1-B, 20 Nov 2026) so the sitemap kind can map a Rezoomo place too; the fetcher re-exports it.
// The 26 counties of the Republic. A location gives the county named first in the text, as a whole word, case ignored
// ("Dublin 2" and "Co. Cork" work).
// D1-B gap round (20 Nov 2026): with no county named, a Republic town gives its county ("Bray" is Wicklow). The table towns-ie.json is
// built by packages/sources/scripts/towns-ie.py from GeoNames (CC BY 4.0, https://creativecommons.org/licenses/by/4.0/), read 20 Nov 2026:
// https://download.geonames.org/export/dump/cities500.zip (country IE, which is the Republic only; 500 people or more) and
// https://download.geonames.org/export/dump/admin2Codes.txt (the county of each place). Northern Ireland is never in it: a name GeoNames
// also has in Northern Ireland (Newcastle, Dundrum, Crumlin) is left out, so it maps to no county. 602 names: each place's `name` and
// `asciiname`, plus only other names labelled English (language "en" or the English Wikipedia title, from alternatenames/IE.zip).
import TOWNS from "./towns-ie.json" with { type: "json" };
const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;
const FIND = new RegExp(`(?<![a-z])(${COUNTIES.join("|")})(?![a-z])`, "i");

const TOWN = new Map(Object.entries(TOWNS as Record<string, string>));
const FIRST = new Set([...TOWN.keys()].map((k) => k.split(" ")[0]!)); // a word no name starts with costs one lookup
const LONGEST = Math.max(...[...TOWN.keys()].map((k) => k.split(" ").length)); // words in the longest name (3)

export function countyOf(location: string): string | null {
  const text = location.slice(0, 2000);
  const hit = FIND.exec(text)?.[1]?.toLowerCase();
  const county = COUNTIES.find((c) => c.toLowerCase() === hit);
  if (county) return county;
  // the first town in the text, the longest name at each word ("Carrick on Shannon" before "Carrick")
  const words = text.toLowerCase().split(/[^\p{L}'-]+/u).filter(Boolean);
  for (let i = 0; i < words.length; i++)
    if (FIRST.has(words[i]!)) for (let n = Math.min(LONGEST, words.length - i); n > 0; n--) {
      const c = TOWN.get(words.slice(i, i + n).join(" "));
      if (c) return c;
    }
  return null;
}
