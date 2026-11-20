// Moved from packages/fetcher/src/county.ts (D1-B, 20 Nov 2026) so the sitemap kind can map a Rezoomo place too; the fetcher re-exports it.
// The 26 counties of the Republic. A location gives the county named first in the text, as a whole word, case ignored
// ("Dublin 2" and "Co. Cork" work). Towns wait: the Python has four town lists that differ (PORT-MAP 5.5).
const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick",
  "Longford", "Louth", "Mayo", "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
] as const;
const FIND = new RegExp(`(?<![a-z])(${COUNTIES.join("|")})(?![a-z])`, "i");

export function countyOf(location: string): string | null {
  const hit = FIND.exec(location.slice(0, 2000))?.[1]?.toLowerCase();
  return COUNTIES.find((c) => c.toLowerCase() === hit) ?? null;
}
