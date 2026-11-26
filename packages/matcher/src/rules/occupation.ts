// Title to occupation code. Python: prototype/classify.py:101-122 (R07 matching, R08 description tests),
// used at classify.py:212-216. Behaves exactly like the Python, known misses included, except the GF1 narrowing below.
// The "not on the list" test before the "low confidence" test (classify.py:215-216) belongs to the
// decision chain, not here: this only returns the match.
import type { Matcher, OccupationMatch } from "../types";
import { pyRegex } from "./pyRegex";
import { TITLE_RULES } from "./titleRules";

// classify.py:101-103, all re.I
const IT_CONTEXT = pyRegex(String.raw`\b(software|cloud|aws|azure|gcp|saas|oracle|sap|salesforce|microsoft|dynamics|servicenow|workday|data platform|api|devops|agile|it systems?|erp|crm|python|java|sql)\b`, true);
const CONSTRUCTION_CONTEXT = pyRegex(String.raw`\b(construction|site|civil|building|contractor|mep|infrastructure project|fit[- ]out)\b`, true);
const NON_EEA_LANG = pyRegex(String.raw`\b(mandarin|chinese|cantonese|japanese|korean|arabic|hindi|turkish|russian|ukrainian|hebrew|thai|vietnamese|indonesian|malay|tagalog|urdu|farsi|persian)\b`, true);
// classify.py:115-116
const ENGINEER_WORD = pyRegex(String.raw`\bengineer`);
const FIELD_ENGINEER = pyRegex("field service|installation|install|maintenance|service engineer|customer engineer|support engineer|incident|operations engineer");

const RULES = TITLE_RULES.map((rule) => ({ ...rule, regex: pyRegex(rule.pattern) }));

const match = (code: string, onCriticalSkillsList: OccupationMatch["onCriticalSkillsList"], confidence: OccupationMatch["confidence"]): OccupationMatch => ({ occupationCode: code, onCriticalSkillsList, confidence });

// NEW BEHAVIOUR (26 November 2026, GF1), not in the Python. The reviewer's hand check (planning folder, step5/gate/HAND-CHECK-RESULT.md)
// found title words of two rules read too widely. Each is narrowed only as far as the 1,303 labelled adverts allow: no badge the key
// or the reviewer called right is lost (QA auditors, a fund accounting manager and construction risk managers keep theirs).
// 2421 (chartered and certified accountants): a health and safety auditor is 3567 and a fund accounting associate 4129, both Ineligible.
// 2424 (finance, investment, risk, credit and fraud analytics): financial planning and analysis (FP&A) and customer risk are neither.
const SAFETY = pyRegex(String.raw`\b(health (and|&) safety|h ?& ?s|ehs|safety)\b`);
const AUDIT = pyRegex(String.raw`\baudit`);
const CONSTRUCTION = pyRegex(String.raw`\bconstruction\b`);
const FUND = pyRegex(String.raw`\bfund account`);
const ASSOCIATE = pyRegex(String.raw`\bassociate\b`);
const QUALIFIED = pyRegex(String.raw`\b(chartered|aca|acca|cpa|qualified)\b`);
const NOT_ANALYTICS = pyRegex(String.raw`\b(fp ?& ?a|financial planning|customer risk)\b`);

/** The GF1 narrowing of a 2421 or 2424 title match, or null when the Python's answer stands. `t` is the padded lower-case title. */
export function narrowed(code: string, t: string): OccupationMatch | null {
  if (code === "2421" && SAFETY.test(t) && AUDIT.test(t) && !CONSTRUCTION.test(t)) return match("3567", "no", "medium");
  if (code === "2421" && FUND.test(t) && ASSOCIATE.test(t) && !QUALIFIED.test(t)) return match("4129", "no", "medium");
  if (code === "2424" && NOT_ANALYTICS.test(t)) return match("none", "unknown", "none");
  return null;
}

/** First `count` code points, as Python's `text[:count]` (JavaScript slices UTF-16 units). */
const head = (text: string, count: number) => Array.from(text.slice(0, count * 2)).slice(0, count).join("");

export function occupation(title: string, description: string): OccupationMatch {
  const desc = description ?? "";
  const t = ` ${(title ?? "").toLowerCase()} `;
  for (const rule of RULES) {
    if (!rule.regex.test(t)) continue;
    const { code } = rule;
    if (code === "AMBIG-PM") {
      if (IT_CONTEXT.test(desc)) return match("2134", "yes", "medium");
      if (CONSTRUCTION_CONTEXT.test(desc)) return match("2436", "yes", "medium");
    }
    if (code === "AMBIG-BA" && IT_CONTEXT.test(desc)) return match("2135", "yes", "medium");
    if (code === "AMBIG-ARCH") return IT_CONTEXT.test(desc) ? match("2135", "yes", "medium") : match("2431", "yes", "medium");
    if (code === "AMBIG-GENERIC" && ENGINEER_WORD.test(t)) {
      return FIELD_ENGINEER.test(t) ? match("engineer?", "unknown", "low") : match("212x/213x", "yes", "medium");
    }
    if (code === "3542?") {
      return NON_EEA_LANG.test(`${title} ${head(desc, 3000)}`) ? match("3542", "yes", "low") : match("3542", "no", "medium");
    }
    return narrowed(code, t) ?? match(code, rule.onList, rule.confidence);
  }
  return match("none", "unknown", "none");
}

/**
 * Up to `max` SOC 2010 codes for an employer's typed title (P5): the matcher's own answer first, then the codes of the other title rules
 * that match, in rule order. Codes that are not four digits (intern, the AMBIG groups, "none") are left out. No description, no AI.
 */
export function suggestCodes(title: string, max = 3): string[] {
  const t = ` ${title.toLowerCase()} `;
  const codes = [occupation(title, "").occupationCode, ...RULES.filter((r) => r.regex.test(t)).map((r) => r.code)];
  return [...new Set(codes.filter((c) => /^\d{4}$/.test(c)))].slice(0, max);
}

export const rulesMatcher: Matcher = async (title, description) => occupation(title, description);
