// Title to occupation code. Python: prototype/classify.py:101-122 (R07 matching, R08 description tests),
// used at classify.py:212-216. Behaves exactly like the Python, known misses included.
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
    return match(code, rule.onList, rule.confidence);
  }
  return match("none", "unknown", "none");
}

export const rulesMatcher: Matcher = async (title, description) => occupation(title, description);
