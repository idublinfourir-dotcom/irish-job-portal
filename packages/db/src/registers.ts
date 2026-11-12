// The CRO company register and the WRC agency list (decisions #185, #207 to #212): the pieces both importers share.
// The same number and name rules are in SQL, in private.register_organisation and private.normalise_company_name (migration 0014);
// test/registers.test.ts runs both on the same cases so the two cannot drift apart.

/** The wording the CRO's CC BY 4.0 licence asks every product that uses the data to show (opendata.cro.ie/about). Site pages show it later. */
export const CRO_ATTRIBUTION =
  "Contains Irish Public Sector Data licensed under a Creative Commons Attribution 4.0 International (CC BY 4.0) licence. Source: Companies Registration Office, https://opendata.cro.ie/dataset/companies";

/**
 * The CRO status texts we keep (#207), compared after trimming (the file has "Normal " with a trailing space on most rows).
 * Normal, and the three "about to leave" statuses, so a company in strike off, liquidation or examinership is still found and flagged.
 * Everything else (Dissolved, Ceased, Struck Off, "Liquidation (UK)", "Liquidation stayed", "Administration" and so on) is not kept.
 */
export const KEPT_CRO_STATUSES = ["Normal", "Strike Off Listed", "Liquidation", "Examinership"] as const;
const KEPT = new Set<string>(KEPT_CRO_STATUSES);
export const isKeptStatus = (status: string): boolean => KEPT.has(status.trim());

const LEGAL_FORM = "ltd|limited|dac|clg|plc|ulc|teoranta|teo|designated activity company|company limited by guarantee|public limited company|unlimited company";
const TRAILING_FORM = new RegExp(`(?: (?:${LEGAL_FORM}))+$`);
const FADA: Record<string, string> = { Á: "a", É: "e", Í: "i", Ó: "o", Ú: "u", á: "a", é: "e", í: "i", ó: "o", ú: "u" };

/**
 * The key two company names are compared on: lower case, fadas removed, "&" as "and", everything but letters and digits as one space,
 * and the legal form at the end dropped ("ACME LIMITED", "Acme Ltd." and "acme" all give "acme"). A name that is only a legal form keeps it.
 */
export function normaliseCompanyName(name: string): string {
  const key = name.replace(/[ÁÉÍÓÚáéíóú]/g, (c) => FADA[c]!).toLowerCase().replaceAll("&", " and ").replace(/[^a-z0-9]+/g, " ").trim();
  return key.replace(TRAILING_FORM, "") || key;
}

/** A typed CRO number as the register stores it: spaces and a leading IE removed, leading zeros dropped. */
export const normaliseCroNumber = (typed: string): string => typed.replace(/\s+/g, "").replace(/^ie/i, "").replace(/^0+(?=\d)/, "");

/** A typed WRC licence number as the list stores it: spaces removed, upper case, and EA added when only digits were typed. */
export function normaliseLicenceNumber(typed: string): string {
  const n = typed.replace(/\s+/g, "").toUpperCase();
  return /^\d+$/.test(n) ? `EA${n}` : n;
}

const COUNTIES = [
  "Carlow", "Cavan", "Clare", "Cork", "Donegal", "Dublin", "Galway", "Kerry", "Kildare", "Kilkenny", "Laois", "Leitrim", "Limerick", "Longford", "Louth", "Mayo",
  "Meath", "Monaghan", "Offaly", "Roscommon", "Sligo", "Tipperary", "Waterford", "Westmeath", "Wexford", "Wicklow",
  "Antrim", "Armagh", "Derry", "Down", "Fermanagh", "Tyrone",
];
const COUNTY_BY_WORD = new Map(COUNTIES.map((c) => [c.toLowerCase(), c]));
COUNTY_BY_WORD.set("londonderry", "Derry");

/**
 * The county named in the last address line that names one: "Co. Cork", "County Cork", "Cork" and "Dublin 2" all give a county; anything else gives null.
 * Only a whole line is read (not a word inside a street name), so "Cork Street" is not a county.
 */
export function guessCounty(lines: string[]): string | null {
  for (const line of [...lines].reverse()) {
    const words = line.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/ +/g, " ").trim().replace(/^(co|county) /, "").replace(/ \d+\w?$/, "");
    const county = COUNTY_BY_WORD.get(words);
    if (county) return county;
  }
  return null;
}

/** A line of the import log or a refusal; the importers print these and the tests read them. */
export class ImportRefused extends Error {}
