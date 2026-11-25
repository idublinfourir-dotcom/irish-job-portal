import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Notice } from "@portal/ui";
import { PORTAL_SIGN_IN, readCompany, readLogin, readTeam } from "../../lib/data";
import { meta } from "../_site/meta";
import { TeamBoard, type Team } from "./forms";

export const metadata: Metadata = meta("Team", "See who is in your company's team on Irish Work Permit. The account owner invites teammates, answers join requests, changes roles and transfers ownership.");

type Read = { team?: { myMembershipId: string; members: Team["members"]; invites?: Team["invites"]; requests?: Team["requests"] } | null };

/** Frame E19 (DD17). Signed out goes to sign-in, no company to the claim step. Any member sees the people; only the account owner gets the buttons and sees invitations and requests. */
export default async function Page() {
  const [login, read, company] = await Promise.all([readLogin().catch(() => null), readTeam().catch(() => null), readCompany().catch(() => null)]);
  if (!login || read?.status === 401) redirect(`${PORTAL_SIGN_IN}?next=${encodeURIComponent("/team")}`);
  const t = read?.status === 200 ? (read.body as Read).team : undefined;
  if (!login.membership || t === null) redirect("/sign-up/claim");
  if (!t) return <div className="py-8"><Notice kind="error" title="We cannot show this page now">{read?.status === 403 ? "This login cannot open it. Use the contact form on the Help page." : "Try again in a few minutes."}</Notice></div>;
  const limit = company?.status === 200 && typeof (company.body.company as { memberLimit?: unknown }).memberLimit === "number" ? (company.body.company as { memberLimit: number }).memberLimit : 10;
  return <TeamBoard team={{ members: t.members, invites: t.invites ?? [], requests: t.requests ?? [] }} myId={t.myMembershipId} isOwner={login.membership.role === "account_owner"} limit={limit} />;
}
