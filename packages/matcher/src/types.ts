// Shared types for the occupation matcher. Python: prototype/classify.py:105-122 (`occupation`).

// classify.py returns True / False / None for the list test.
export type OnCriticalSkillsList = "yes" | "no" | "unknown";

// classify.py rules use "high", "medium", "low"; no match returns "none" (:122).
export type MatchConfidence = "none" | "low" | "medium" | "high";

export type OccupationMatch = {
  /** First tuple item: a four digit code, or a loose label such as "AMBIG-*" resolved to "212x/213x", "engineer?", or "none" */
  occupationCode: string;
  /** Second tuple item: True / False / None */
  onCriticalSkillsList: OnCriticalSkillsList;
  /** Third tuple item */
  confidence: MatchConfidence;
};

// One function, so the rules matcher and a later AI matcher are interchangeable.
export type Matcher = (title: string, description: string) => Promise<OccupationMatch>;
