// The 44 search terms in 7 groups. Python: prototype/fetch_linkedin_lib.py:5-17 (KEYWORDS). Order matters: it is the search order.
export const TERM_GROUPS: readonly (readonly [string, readonly string[]])[] = [
  ["health", ["staff nurse", "registered nurse", "clinical nurse manager", "midwife", "senior house officer", "registrar doctor",
    "consultant psychiatrist", "general practitioner", "pharmacist", "physiotherapist", "occupational therapist",
    "radiographer", "medical scientist", "speech and language therapist", "social worker", "dietitian",
    "healthcare assistant", "home support worker"]],
  ["hospitality", ["chef de partie", "sous chef", "hotel manager"]],
  ["it", ["software engineer", "data engineer", "devops engineer", "data scientist", "it project manager", "business analyst"]],
  ["construction", ["civil engineer", "quantity surveyor", "site engineer", "electrical engineer", "mechanical engineer",
    "bim coordinator", "project engineer", "construction project manager"]],
  ["finance", ["accountant", "tax manager", "financial analyst", "risk analyst"]],
  ["pharma", ["process engineer", "validation engineer", "qc analyst", "quality assurance specialist"]],
  ["retail", ["store manager"]],
];
