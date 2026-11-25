import type { Metadata } from "next";
import { readPayFloors } from "../../lib/data";
import { bodyOf, member } from "../_jobs/guard";
import { meta } from "../_site/meta";
import { PayFloorsView, type Floor, type FloorText } from "./view";

export const metadata: Metadata = meta("Pay floors", "Sign a pay floor for a role family if your company is on the big-company list, see the floors you signed with their status and end date, and withdraw one.");

/** DD33. One read (the company's floors and the wording in force). Any member can read; the form and Withdraw are for a role that can sign, and the route decides who may (NOT_SIGNER, NOT_BIG_COMPANY). */
export default async function Page() {
  const m = await member("/pay-floors");
  const r = await readPayFloors().catch(() => null);
  return <PayFloorsView canSign={m.role !== "viewer"} text={bodyOf<FloorText | null>(r, "text") ?? null} floors={bodyOf<Floor[]>(r, "floors")} />;
}
