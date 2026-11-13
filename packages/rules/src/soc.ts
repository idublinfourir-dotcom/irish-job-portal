// The official SOC 2010 unit groups (ONS, 369 four-digit codes): the one list every occupation-code check reads. Source and licence: the data file.
import soc from "../data/soc2010-unit-groups.json";

const TITLES: ReadonlyMap<string, string> = new Map(soc.unit_groups.map((u) => [u.code, u.title]));
export const SOC2010_CODES: ReadonlySet<string> = new Set(TITLES.keys());
export const isSoc2010 = (code: unknown): code is string => typeof code === "string" && SOC2010_CODES.has(code);
export const socTitle = (code: string): string | null => TITLES.get(code) ?? null;
