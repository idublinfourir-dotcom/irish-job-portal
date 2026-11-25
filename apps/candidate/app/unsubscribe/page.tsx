// /unsubscribe?token=&scope=one|all (DD29): where a job alert email's Stop links land. Reads what the link would stop and changes nothing; Confirm posts to
// the API. No sign-in, noindex, no referrer, no third-party request. An unknown token and a malformed link both show the bad-link state.
import type { Metadata } from "next";
import { connection } from "next/server";
import { readUnsubscribe } from "../../lib/data";
import { authMeta } from "../(auth)/meta";
import { safe } from "../_home/safe";
import { UnsubscribeFlow } from "./flow";
import { parseLink, unsubscribeSay } from "./messages";
import { UnsubscribeView, type Alert } from "./views";

export const generateMetadata = (): Metadata => authMeta("Stop job alert emails", "Stop one job alert, or all of them, from the link in a job alert email. Nothing changes until you press Confirm, so opening the link is safe.", { referrer: "no-referrer" });

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[]; scope?: string | string[] }> }) {
  await connection();
  const q = await searchParams;
  const link = parseLink(q.token, q.scope);
  if (!link) return <UnsubscribeView view="bad" scope="one" alert={null} />;
  const r = await safe(readUnsubscribe(link.token, link.scope), "unsubscribe");
  const alert = r.ok ? (r.data as { alert: Alert | null }).alert : null;
  if (!alert) return <UnsubscribeView view="bad" scope={link.scope} alert={null} problem={!r.ok && r.status !== 400 ? unsubscribeSay(r) : undefined} />;
  if (alert.status === "unsubscribed" && link.scope === "one") return <UnsubscribeView view="already" scope={link.scope} alert={alert} />;
  const other = new URLSearchParams({ token: link.token, scope: link.scope === "one" ? "all" : "one" });
  return <UnsubscribeFlow token={link.token} scope={link.scope} alert={alert} otherHref={`/unsubscribe?${other}`} />;
}
