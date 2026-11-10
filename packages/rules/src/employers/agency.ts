import { pyRegex } from "./py-text";

// R16 agency by employer name. Python: prototype/classify.py:184 (used at :204). Loose on purpose in the Python:
// words such as "people", "search" and "jobs" match many non-agency names.
const AGENCY = pyRegex(
  String.raw`recruit|personnel|staffing|talent|resourcing|careers|search|selection|placement|appointments|people|hire|jobs|workforce|cpl|hays|morgan mckinley|sigmar|osborne|excel|lincoln|grafton|collins mcnicholas|brightwater|harvey nash|robert (half|walters)|randstad|adecco|manpower|hcl recruit|kare|medisource|nurse ?finders|globalmed`,
  "i",
);

/** R16: does the employer name look like an agency? Python: `bool(AGENCY.search(j["employer"] or ""))`. */
export const isAgencyName = (employer: string | null | undefined): boolean => AGENCY.test(employer ?? "");
