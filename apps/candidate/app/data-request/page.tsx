// /data-request?token= (DD30): where a data request email's button lands. Reads what the request is and when the link ends and changes nothing; Confirm posts
// to the API. No sign-in, noindex, no referrer, no third-party request. Unknown, used, expired and closed links all show the same state.
import type { Metadata } from "next";
import { connection } from "next/server";
import { readDataRequest } from "../../lib/data";
import { authMeta } from "../(auth)/meta";
import { safe } from "../_home/safe";
import { DataRequestFlow } from "./flow";
import { dataRequestSay, parseToken } from "./messages";
import { DataRequestView, type Purpose } from "./views";

export const generateMetadata = (): Metadata => authMeta("Confirm your data request", "Confirm a request about the data in your account: a copy of your data, or deletion of your account. Nothing happens until you press Confirm on this page.", { referrer: "no-referrer" });

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  await connection();
  const q = await searchParams, token = parseToken(q.token);
  if (!token) return <DataRequestView view="bad" purpose="export" />;
  const r = await safe(readDataRequest(token), "data request");
  if (!r.ok) return <DataRequestView view={r.status === 404 ? "invalid" : "bad"} purpose="export" problem={dataRequestSay({ ok: false, status: r.status, code: r.code })} />;
  const d = r.data as { purpose: Purpose; expiresAt: string };
  return <DataRequestFlow token={token} purpose={d.purpose === "erase" ? "erase" : "export"} expiresAt={d.expiresAt} />;
}
