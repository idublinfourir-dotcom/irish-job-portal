// The official SOC 2010 unit groups (ONS, 369 four-digit codes): the one list every occupation-code check reads. Source and licence: the data file.
import soc from "../data/soc2010-unit-groups.json";

const TITLES: ReadonlyMap<string, string> = new Map(soc.unit_groups.map((u) => [u.code, u.title]));
export const SOC2010_CODES: ReadonlySet<string> = new Set(TITLES.keys());
export const isSoc2010 = (code: unknown): code is string => typeof code === "string" && SOC2010_CODES.has(code);
export const socTitle = (code: string): string | null => TITLES.get(code) ?? null;

// The address of an occupation page (#288, /occupations/<name-slug>): the unit group title in lower-case letters and digits with single hyphens.
// The 369 titles give 369 different slugs (checked in soc.test.ts), so a slug names one code.
const slugOf = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const SLUGS: ReadonlyMap<string, string> = new Map([...TITLES].map(([code, title]) => [slugOf(title), code]));
export const socSlug = (code: string): string | null => { const t = TITLES.get(code); return t === undefined ? null : slugOf(t); };
export const socCodeOfSlug = (slug: unknown): string | null => (typeof slug === "string" ? (SLUGS.get(slug) ?? null) : null);
