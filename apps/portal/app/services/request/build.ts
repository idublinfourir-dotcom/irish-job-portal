// The body of POST /api/portal/cases from the form's fields (docs/openapi/portal.yaml, requestPortalServicesCase). Pure, so a test holds it to the route's rules: only the documented
// keys, a value of 1 to 500 characters or the key left out, `relevantDegree` as the text true or false, the award month only with a degree, a job id only when one is picked, and the
// idempotency key the form made once (a second send of the same request answers the same case).
const OPTIONAL = ["title", "annualPay", "degreeAwardMonth", "contractMonths", "weeklyHours", "startDate"] as const;
export type CaseBody = { permitType: "critical_skills" | "general"; jobId?: string; offerDetails: Record<string, string>; servicesConsent: true; idempotencyKey: string };

export function buildRequest(f: Record<string, string | undefined>, idempotencyKey: string): CaseBody {
  const offerDetails: Record<string, string> = {};
  const put = (k: string, v: string | undefined) => { const t = v?.trim().slice(0, 500); if (t) offerDetails[k] = t; };
  put("occupationCode", f.occupationCode);
  for (const k of OPTIONAL) if (k !== "degreeAwardMonth" || f.relevantDegree === "yes") put(k, f[k]);
  offerDetails.relevantDegree = f.relevantDegree === "yes" ? "true" : "false";
  const jobId = f.jobId && /^[0-9]{1,18}$/.test(f.jobId) ? f.jobId : undefined;
  return { permitType: f.permitType === "general" ? "general" : "critical_skills", ...(jobId ? { jobId } : {}), offerDetails, servicesConsent: true, idempotencyKey };
}
