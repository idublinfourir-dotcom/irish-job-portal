import { cleanEmployerName } from "./name";

// R15 big-company brand list. Python: prototype/classify.py:186-189 (42 entries).
export const BIG_COMPANY_BRANDS: readonly string[] = [
  "google", "amazon", "microsoft", "meta", "apple", "salesforce", "sfdc", "stripe", "mongodb", "intercom", "servicenow",
  "mastercard", "analog devices", "intel", "workday", "citi", "citibank", "state street", "fidelity", "fmr", "medtronic", "pfizer",
  "abbott", "thermo fisher", "applied materials", "kla", "tiktok", "linkedin", "oracle", "ibm", "dell", "hubspot", "indeed",
  "paypal", "jp morgan", "j p morgan", "bny", "eli lilly", "lilly", "johnson and johnson", "boston scientific", "stryker",
]; // prettier-ignore

// NEW BEHAVIOUR (decisions #150 and #151, 11 November 2026): no Python line. Employers with 250 or more staff in Ireland, or with
// DETE permits in 3 of the last 5 years and 20 or more in total. Cleaned names, matched like the list above. The facts behind each
// name are in the private folder (step5/big-co/verdicts.tsv). Public bodies are not here: they have their own pay tier.
export const BIG_COMPANY_LIST_150: readonly string[] = [
  "abbvie", "affidea", "alliance medical", "anh healthcare", "auxilion", "avista", "be independent home care", "beacon hospital",
  "beechfield care", "blackrock health", "bluebird care", "bon secours", "carechoice", "chemist warehouse", "cowper care centre",
  "curam care homes", "dovida", "genesis healthcare", "grant thornton", "haven bay care centre", "iqvia", "kaseya", "king and moffatt",
  "mater private network", "mccabes pharmacy", "mccauley", "nua healthcare", "optum", "orwell healthcare", "pwc", "sitecore",
  "st john of god university hospital", "trinity care", "turner and townsend", "uniphar", "upmc", "version 1", "vhi", "viatris",
]; // prettier-ignore

const ALL_BIG = [...BIG_COMPANY_BRANDS, ...BIG_COMPANY_LIST_150];

/** R15 and #150: cleaned name equals a listed name, or starts with it plus a space. Python: classify.big_company (:190-192). */
export function isBigCompany(employer: string): boolean {
  const e = cleanEmployerName(employer);
  return ALL_BIG.some((b) => e === b || e.startsWith(b + " "));
}
