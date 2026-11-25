// /account/saved (frame A04): see view.tsx.
import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readSaved } from "../../../lib/data";
import { Failed, Head } from "../parts";
import { SavedView, type SavedRow } from "./view";

export const metadata: Metadata = { title: `Saved jobs | ${SITE_NAME}`, robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ show?: string | string[] }> }) {
  const { show } = await searchParams;
  const read = await readSaved();
  if (!read.ok) return <><Head title="Saved jobs" /><Failed what="your saved jobs" code={read.code} /></>;
  const v = typeof show === "string" && (show === "open" || show === "closed") ? show : "";
  return <SavedView saved={(read.data as { saved: SavedRow[] }).saved} show={v} now={new Date()} />;
}
