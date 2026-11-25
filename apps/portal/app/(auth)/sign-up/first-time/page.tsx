import type { Metadata } from "next";
import { PublicDataCredit } from "@portal/ui";
import { isFreeEmail, readClaimSearch } from "../../../../lib/data";
import { meta } from "../../../_site/meta";
import { needLogin, outLinks } from "../../../_site/guard";
import { SignOutButton } from "../../forms";
import { AuthFrame } from "../../frame";
import { croFound, FirstTimeForm } from "../../company-forms";

export const metadata: Metadata = meta("First-time sponsor", "Give your CRO number and company name. We check your company against the CRO open data and review the account by hand before your jobs go live.");

/** Step 3, frame E04: a company that has not sponsored a permit since 2019 registers with its CRO number. `?cro=` and `?name=` come from a register row of the claim step. */
export default async function Page({ searchParams }: { searchParams: Promise<{ cro?: string | string[]; name?: string | string[] }> }) {
  const { cro, name } = await searchParams;
  const login = await needLogin("/sign-up/first-time");
  const digits = typeof cro === "string" ? cro.replace(/\s+/g, "").replace(/^ie/i, "") : "";
  const look = /^\d{3,8}$/.test(digits) ? await readClaimSearch({ q: digits }).catch(() => null) : null; // a number the claim step handed over is looked up here, on the server
  return (
    <AuthFrame step={3} title={<>First-time <span className="text-deep-green">sponsor</span></>} lead="We check your company against the CRO open data and review the account by hand."
      panel={["New to sponsoring?", "Welcome."]} panelLead="We aim to review first-time sponsors within 1 working day." {...outLinks()}>
      <FirstTimeForm email={login.email} free={isFreeEmail(login.email)} initialCro={typeof cro === "string" ? cro.slice(0, 20) : ""} initialName={typeof name === "string" ? name.slice(0, 160) : ""} initialFound={look?.status === 200 ? croFound(look.body, digits) : undefined} />
      <p className="text-small text-muted">Not {login.email}? <SignOutButton /></p>
      <div className="text-small text-muted"><PublicDataCredit /></div>
    </AuthFrame>
  );
}
