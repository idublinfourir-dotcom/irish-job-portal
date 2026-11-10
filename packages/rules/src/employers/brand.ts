import { cleanEmployerName } from "./name";

// R15 big-company brand list. Python: prototype/classify.py:186-189 (42 entries).
export const BIG_COMPANY_BRANDS: readonly string[] = [
  "google", "amazon", "microsoft", "meta", "apple", "salesforce", "sfdc", "stripe", "mongodb", "intercom", "servicenow",
  "mastercard", "analog devices", "intel", "workday", "citi", "citibank", "state street", "fidelity", "fmr", "medtronic", "pfizer",
  "abbott", "thermo fisher", "applied materials", "kla", "tiktok", "linkedin", "oracle", "ibm", "dell", "hubspot", "indeed",
  "paypal", "jp morgan", "j p morgan", "bny", "eli lilly", "lilly", "johnson and johnson", "boston scientific", "stryker",
]; // prettier-ignore

/** R15: cleaned name equals a brand, or starts with it plus a space. Python: classify.big_company (:190-192). */
export function isBigCompany(employer: string): boolean {
  const e = cleanEmployerName(employer);
  return BIG_COMPANY_BRANDS.some((b) => e === b || e.startsWith(b + " "));
}
