// The documents staff may ask a requester for (S-Q4 A): a fixed list of codes, placeholder labels until the services team gives the real list.
// Staff tick codes; services_case.documents_needed and case_event.detail hold codes only (each code passes 0061's private.case_codes_ok);
// the timeline and the board show the labels.
export const CASE_DOCUMENT_CODES = {
  passport_copy: "Passport copy",
  offer_letter: "Job offer letter",
  contract: "Employment contract",
  degree: "Degree or qualification",
  registration: "Professional registration",
  payslip: "Recent payslip",
  cv: "CV",
  other: "Other document",
} as const satisfies Record<string, string>;
export type CaseDocumentCode = keyof typeof CASE_DOCUMENT_CODES;

export const isCaseDocumentCode = (c: unknown): c is CaseDocumentCode => typeof c === "string" && Object.hasOwn(CASE_DOCUMENT_CODES, c);
/** Codes as { code, label }; a code no longer in the list (an old row) keeps its code with a null label. Pure. */
export const documentLabels = (codes: readonly string[]) =>
  codes.map((code) => ({ code, label: isCaseDocumentCode(code) ? CASE_DOCUMENT_CODES[code] : null }));
