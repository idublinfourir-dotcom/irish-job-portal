// /data-request?token= (DD30): where a data request email's button lands, for an employer or agency login. Reads what the request is and when the link ends and
// changes nothing; Confirm posts to the API. No sign-in, noindex, no referrer, no third-party request. Unknown, used, expired and closed links show the same state.
import type { Metadata } from "next";
import { connection } from "next/server";
import { readDataRequest } from "../../lib/data";
import { outLinks } from "../_site/guard";
import { tokenMeta } from "../_site/meta";
import { DataRequestFlow } from "./flow";
import { dataRequestSay, parseToken } from "./messages";
import { DataRequestView, type Purpose } from "./views";

export const metadata: Metadata = tokenMeta("Confirm your data request", "Confirm a request about the data in your employer or agency login: a copy of your data, or deletion of your login. Nothing happens until you press Confirm.");

export default async function Page({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  await connection();
  const q = await searchParams, token = parseToken(q.token), links = outLinks();
  if (!token) return <DataRequestView view="bad" purpose="export" links={links} />;
  const r = await readDataRequest(token).catch((e: unknown) => { console.error("data request read failed", e); return { status: 500, body: { code: "READ_FAILED" } }; });
  if (r.status !== 200) return <DataRequestView view={r.status === 404 ? "invalid" : "bad"} purpose="export" problem={dataRequestSay({ ok: false, status: r.status, code: typeof r.body.code === "string" ? r.body.code : undefined })} links={links} />;
  const d = r.body as { purpose: Purpose; expiresAt: string };
  return <DataRequestFlow token={token} purpose={d.purpose === "erase" ? "erase" : "export"} expiresAt={d.expiresAt} links={links} />;
}
