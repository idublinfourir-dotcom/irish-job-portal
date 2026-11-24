// The words of the account review page: what each fact about a claim says. Pure, so a test covers every case. The facts come from the review read (account-review.ts, B61).
import type { ReviewItem } from "@portal/db";

export const TYPE_LABEL: Record<string, string> = { dete_claim: "Existing sponsor", first_time: "First-time sponsor", agency: "Agency" };
export const typeLabel = (i: Pick<ReviewItem, "signupPath" | "kind">) => (i.signupPath ? TYPE_LABEL[i.signupPath] : undefined) ?? (i.kind === "agency" ? "Agency" : "Employer");

export type Tone = "peach" | "error" | "green";
export type Flag = { text: string; tone: Tone };

const detail = (d: unknown): Record<string, unknown> => (d !== null && typeof d === "object" && !Array.isArray(d) ? (d as Record<string, unknown>) : {});

/** The flags of a list row: why a reviewer should look closely. Never a refusal. */
export function flagsOf(i: ReviewItem): Flag[] {
  const d = detail(i.detail);
  const out: Flag[] = [];
  if (i.banned) out.push({ text: "On ban list", tone: "error" });
  if (i.freeEmail) out.push({ text: "Free email", tone: "peach" });
  if (i.flags.includes("lookalike_domain")) out.push({ text: "Lookalike domain", tone: "error" });
  if (i.flags.includes("shared_mailbox")) out.push({ text: "Shared mailbox", tone: "peach" });
  if (i.nonDomainEmail && !i.freeEmail) out.push({ text: "Non-domain email", tone: "peach" });
  if (i.kind === "agency" && d.found === true) out.push({ text: d.possibly_lapsed === true ? "Licence may have lapsed" : "Licence found", tone: d.possibly_lapsed === true ? "peach" : "green" });
  return out;
}

export type Check = { title: string; ok: boolean; text: string };

/** The five checks of the detail card (frame D02): the register, the DETE history, the email domain, the ban list and the licence. */
export function checksOf(i: ReviewItem): Check[] {
  const d = detail(i.detail);
  const out: Check[] = [];
  const found = d.found === true;
  if (i.kind === "agency") {
    out.push({ title: "Licence check", ok: found && d.possibly_lapsed !== true && d.name_matches === true, text: !found ? `Licence ${i.wrcLicenceNumber ?? "number"} is not on the agency register.` : `Licence ${i.wrcLicenceNumber ?? ""} is on the agency register${d.name_matches === true ? ", name matches" : ", but the name does not match"}${d.possibly_lapsed === true ? ". It may have lapsed: the last two register imports did not list it" : ""}.`.replace(" .", ".") });
  } else {
    const status = typeof d.status === "string" && d.status ? ` · status ${d.status}` : "";
    out.push({ title: "CRO lookup", ok: found && d.name_matches === true, text: d.register === undefined && !found ? (i.croNumber ? `CRO number ${i.croNumber}. No register check was made at claim.` : "No CRO number on this company. No register check was made at claim.") : found ? `Number ${i.croNumber ?? ""} exists${status} · name ${d.name_matches === true ? "matches" : "does not match"}.` : `Number ${i.croNumber ?? ""} is not in the CRO register.` });
    out.push({ title: "Licence check", ok: true, text: "Not an agency." });
  }
  const history = i.permitHistory === "has_history";
  const firstTimeButHistory = i.signupPath === "first_time" && history;
  out.push({
    title: "DETE match",
    ok: !firstTimeButHistory,
    text: firstTimeButHistory
      ? `Permits on record${i.lastPermitYear ? `, the newest in ${i.lastPermitYear}` : ""}. It cannot be approved as a first-time sponsor.`
      : history ? `Permits on record${i.lastPermitYear ? `, the newest in ${i.lastPermitYear}` : ""}.`
      : i.signupPath === "first_time" ? "No permits on record. The label will be \"First-time sponsor\"." : "No permits on record.",
  });
  const domain = i.emailDomain;
  const email: string[] = [];
  if (domain === null) email.push("No owner email on record.");
  else {
    if (i.freeEmail) email.push(`Free provider (${domain}).`);
    else if (i.nonDomainEmail) email.push(`${domain} is not saved as one of the company's domains yet.`);
    else email.push(`${domain} is a saved domain of this company.`);
    if (i.flags.includes("lookalike_domain")) email.push(`It looks like ${i.lookalikeOf ?? "another company's domain"}.`);
    if (i.flags.includes("shared_mailbox")) email.push("The address is a shared mailbox, not one person's.");
  }
  out.push({ title: "Email domain", ok: domain !== null && !i.freeEmail && !i.nonDomainEmail && i.flags.length === 0, text: email.join(" ") });
  out.push({ title: "Ban list", ok: !i.banned, text: i.banned ? "The owner's email or domain, or a company number, is on the ban list. Approve will be refused." : "Email, domain and company number are not banned." });
  return out;
}

/** The first line of the detail card: who signed up, from the facts held. The owner's name and email are plain text. */
export const signedUpBy = (i: Pick<ReviewItem, "claimantName" | "claimantEmail">) =>
  i.claimantEmail === null ? "No active owner on record." : `Signed up by ${i.claimantName ?? "an owner"} · ${i.claimantEmail}`;

/** What happened to a decided item, for its detail card. */
export const outcomeText = (i: Pick<ReviewItem, "outcome" | "organisationStatus">): string | null =>
  i.outcome === "approved" ? "Approved" : i.outcome === "rejected" ? "Rejected" : i.outcome === "needs_info" ? "Asked for more information" : null;

// Reject reason codes. The route takes any lower-case code (the audit log holds codes, never free text, #182); the list is placeholder wording until the owner fixes the real one.
export const REJECT_REASONS: readonly [string, string][] = [
  ["cannot_verify", "Cannot verify the company"],
  ["not_a_real_company", "Not a real company"],
  ["register_mismatch", "Does not match the register"],
  ["email_not_company", "Email does not belong to the company"],
  ["duplicate", "Duplicate of another sign-up"],
  ["other", "Another reason"],
];
