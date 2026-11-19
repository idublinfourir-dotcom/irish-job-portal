// Health registration bodies (S6, decision #269: a code file, changed by a PR). Read on each body's own pages on 19 November 2026
// (step15/s6-registration-bodies.md and .tsv, with the URLs). Every line a person reads is placeholder wording for the content writers.
// reviewOn is 6 months after readOn; the daily reminders (scheduled-checks-cli.ts) open a review item for a body once it has come.
// No imports, so the node CLIs can load this file directly.

export type RegistrationBody = { id: string; name: string; url: string; readOn: string; reviewOn: string; steps: readonly string[] };
export type Registration = {
  /** required: the job needs this body's registration; may_need: the code mixes regulated and unregulated roles; not_open: no register yet. */
  status: "required" | "may_need" | "not_open";
  body: { id: string; name: string; url: string; readOn: string };
  line: string;
  /** For an applicant trained outside the EU. Empty unless status is required. */
  steps: readonly string[];
  /** Nurses and midwives only: what "relevant degree" means for them (DETE's Critical Skills page). */
  degreeNote?: string;
};

const READ = { readOn: "2026-11-19", reviewOn: "2027-05-19" };
const CORU_URL = "https://www.coru.ie/health-and-social-care-professionals/registration/international-applicants/how-to-apply/";

export const REGISTRATION_BODIES = {
  nmbi: {
    id: "nmbi", name: "Nursing and Midwifery Board of Ireland (NMBI)", url: "https://www.nmbi.ie/Registration/Qualified-outside-the-EU", ...READ,
    steps: [
      "Apply to NMBI to have your qualification recognised (stage 1).",
      "NMBI may ask for an adaptation period or an aptitude test.",
      "Apply for registration (stage 2), with your English language evidence.",
    ],
  },
  medical_council: {
    id: "medical_council", name: "Medical Council", url: "https://www.medicalcouncil.ie/registration-applications/first-time-applicants/", ...READ,
    steps: [
      "Check which division of the register fits you.",
      "Create a Doctors Portal account and apply online.",
      "Send the supporting documents. Doctors trained outside the EU pass the PRES exam or show an exemption.",
    ],
  },
  coru: {
    id: "coru", name: "CORU (Health and Social Care Professionals Council)", url: CORU_URL, ...READ,
    steps: [
      "Apply online to CORU to have your qualification recognised.",
      "Complete eVetting and send the declaration and practice forms.",
      "Apply for registration once your file is complete (both can run at the same time).",
    ],
  },
  phecc: {
    id: "phecc", name: "Pre-Hospital Emergency Care Council (PHECC)", url: "https://phecc.ie/register/recognition-of-qualifications/", ...READ,
    steps: [
      "Apply to PHECC to have your qualification recognised (usually about 3 months).",
      "Then apply to join the PHECC register.",
    ],
  },
  psi: {
    id: "psi", name: "Pharmaceutical Society of Ireland (PSI)",
    url: "https://www.psi.ie/registration/pharmacists/first-time-registration/qualification-obtained-outside-eu", ...READ,
    steps: [
      "Apply to the PSI to have your qualification recognised (three stages, with an exam).",
      "Then apply for registration, with your English language evidence.",
    ],
  },
} as const satisfies Record<string, RegistrationBody>;
type BodyId = keyof typeof REGISTRATION_BODIES;

/** Occupation code to body. Codes that mix regulated and unregulated roles are in MIXED instead. */
const BY_CODE = new Map<string, BodyId>([
  ["2211", "medical_council"], ["2231", "nmbi"], ["2232", "nmbi"], ["2213", "psi"],
  ["2214", "coru"], ["2218", "coru"], ["2221", "coru"], ["2222", "coru"], ["2223", "coru"], ["2442", "coru"],
  ["3213", "phecc"], ["6142", "phecc"],
]);
/** The mixed codes: a title known to be CORU-regulated shows CORU's steps, one known to be unregulated shows nothing, any other the cautious line. */
const MIXED = new Set(["2217", "2219", "2112"]);
const REGULATED = /\b(radiographer|radiation therapist|dietitian|dietician|(bio)?medical (laboratory )?scientist)\b/;
const UNREGULATED = /\b(physiologist|audiologist|perfusionist|technologist|biologist|biochemist|microbiologist|bioprocess|scientist)\b/;
const NOT_OPEN = new Map<string, { body: BodyId; url: string }>([
  ["2212", { body: "coru", url: "https://www.coru.ie/about-us/registration-boards/psychologists-registration-board/statutory-regulation-of-psychologists/" }],
]);
const DEGREE_NOTE = "For nurses and midwives, a relevant degree means a degree or diploma accepted by NMBI.";

const ref = (b: RegistrationBody, url = b.url) => ({ id: b.id, name: b.name, url, readOn: b.readOn });
const required = (b: RegistrationBody): Registration =>
  ({ status: "required", body: ref(b), line: `You must be registered with ${b.name} to work in this role in Ireland.`, steps: b.steps });

/** The registration a job of this code and title needs, or null (no body, or a title known to be unregulated). Pure. */
export function registrationFor(code: string | null, title?: string | null): Registration | null {
  if (typeof code !== "string") return null;
  const id = BY_CODE.get(code);
  if (id) return id === "nmbi" ? { ...required(REGISTRATION_BODIES.nmbi), degreeNote: DEGREE_NOTE } : required(REGISTRATION_BODIES[id]);
  const n = NOT_OPEN.get(code);
  if (n) {
    return { status: "not_open", body: ref(REGISTRATION_BODIES[n.body], n.url), line: "CORU's register for this profession is not open yet. It is expected in 2027.", steps: [] };
  }
  if (!MIXED.has(code)) return null;
  // the matcher's normalisation (packages/matcher/src/rules/occupation.ts): the lower-cased title padded with one space each side
  const t = ` ${(typeof title === "string" ? title : "").slice(0, 500).toLowerCase()} `;
  if (REGULATED.test(t)) return required(REGISTRATION_BODIES.coru);
  if (UNREGULATED.test(t)) return null;
  return { status: "may_need", body: ref(REGISTRATION_BODIES.coru), line: "This role may need CORU registration. Check with CORU.", steps: [] };
}
