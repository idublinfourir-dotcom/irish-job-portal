// The legal page: reads the public legal route through the data layer and shows its state (legal-view.tsx).
import { Page } from "../_site/chrome";
import { candidateHref, readLegal, type Read } from "../../lib/data";
import { LegalView, type Text } from "./legal-view";

export async function LegalPage({ purpose, title }: { purpose: "portal_signup_terms" | "privacy_notice"; title: string }) {
  const r = await readLegal(purpose).catch((): Read => ({ status: 500, body: {} }));
  const text = r.status === 200 && typeof r.body.body === "string" ? ({ version: String(r.body.version), body: r.body.body, publishedAt: String(r.body.publishedAt) } satisfies Text) : undefined;
  return <Page candidates={candidateHref("/")}><LegalView title={title} status={text ? 200 : r.status === 200 ? 500 : r.status} text={text} /></Page>;
}
