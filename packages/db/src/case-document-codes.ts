// The documents staff may ask a requester for (S-Q4 A): a fixed list of codes. The first eight are the original list (old rows keep them); the rest come from
// DETE's Critical Skills and General Employment Permit checklists, read 26 Nov 2026 (step16/content-drafts/permit-documents.md in the planning folder).
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
  passport_photo: "Passport-type photo",
  immigration_stamp: "Current immigration stamp and visa",
  previous_permits: "Previous permits or visas in Ireland",
  idaei_support_letter: "IDA Ireland or Enterprise Ireland support letter",
  revenue_statement: "Employer Revenue statement (last 3 months)",
  lmnt_advert_evidence: "Labour Market Needs Test adverts (Jobs Ireland and one other)",
  aws_permission_letter: "Atypical Working Scheme letter (nurses)",
  hgv_licence: "CE or C1E driving licence (HGV drivers)",
} as const satisfies Record<string, string>;
export type CaseDocumentCode = keyof typeof CASE_DOCUMENT_CODES;

export const isCaseDocumentCode = (c: unknown): c is CaseDocumentCode => typeof c === "string" && Object.hasOwn(CASE_DOCUMENT_CODES, c);
/** Codes as { code, label }; a code no longer in the list (an old row) keeps its code with a null label. Pure. */
export const documentLabels = (codes: readonly string[]) =>
  codes.map((code) => ({ code, label: isCaseDocumentCode(code) ? CASE_DOCUMENT_CODES[code] : null }));
