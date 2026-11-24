// The writes the content pages make: the contact form and the company report, plain fetch calls to the documented routes (docs/openapi/candidate.yaml).
// Client side. The words for each error code are the job pages' (app/jobs/api.ts), plus the codes only these routes give.
import { send, type Sent } from "../jobs/api";

type F = Parameters<typeof send>[3];

export const COMPANY_REASONS = [
  ["fake_company", "It looks like a fake company"],
  ["asks_for_money", "It asks for money"],
  ["no_sponsorship", "It says it will not sponsor a permit"],
  ["other", "Something else"],
] as const;
export const CONTACT_TOPICS = [
  ["general", "A general question"],
  ["account", "My account"],
  ["data_request", "My data"],
  ["other", "Something else"],
  ["appeal", "An appeal against a suspension"],
] as const;
export const EVIDENCE_MAX = 2000;
export const MESSAGE_MAX = 5000;

const COMPANY_NOT_FOUND = "This company page is no longer available.";
/** A report on a company (BA23): signed in only; one open report a login. */
export async function reportCompany(companyId: string, reason: string, evidence: string, f?: F): Promise<Sent> {
  const r = await send("POST", "/api/report", { companyId, reason, ...(evidence.trim() ? { evidence: evidence.trim() } : {}) }, f);
  return !r.ok && r.code === "COMPANY_NOT_FOUND" ? { ...r, message: COMPANY_NOT_FOUND } : !r.ok && r.code === "ALREADY_REPORTED" ? { ...r, message: "You already have an open report on this company. We are looking at it." } : r;
}

/** The contact form. A visitor gives name and email; a signed-in candidate leaves them out. */
export const sendContact = (topic: string, body: string, who: { name: string; email: string } | null, f?: F) =>
  send("POST", "/api/contact", { topic, body: body.trim(), ...(who ? { name: who.name.trim(), email: who.email.trim() } : {}) }, f);
