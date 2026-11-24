// The body of POST /api/candidate/cases from the form's fields (docs/openapi/candidate.yaml, requestCandidateServicesCase). Pure, so a test holds it to the
// route's rules: only the documented keys, a value of 1 to 500 characters or the key left out, `relevantDegree` as the text true or false, the award month
// only with a degree, and `employerContact` only with a job (the route refuses it without one).
const OPTIONAL = ["employerName", "title", "annualPay", "degreeAwardMonth", "contractMonths", "weeklyHours", "startDate"] as const;
export type CaseBody = { permitType: "critical_skills" | "general"; jobId?: string; offerDetails: Record<string, string>; servicesConsent: true; employerContact?: true };

export function buildRequest(f: Record<string, string | undefined>, jobId: string | null): CaseBody {
  const offerDetails: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => { const t = v?.trim().slice(0, 500); if (t) offerDetails[k] = t; };
  put("occupationCode", f.occupationCode);
  for (const k of OPTIONAL) if (k !== "degreeAwardMonth" || f.relevantDegree === "yes") put(k, f[k]);
  offerDetails.relevantDegree = f.relevantDegree === "yes" ? "true" : "false";
  return { permitType: f.permitType === "general" ? "general" : "critical_skills", ...(jobId ? { jobId } : {}), offerDetails, servicesConsent: true, ...(jobId && f.employerContact === "on" ? { employerContact: true as const } : {}) };
}
