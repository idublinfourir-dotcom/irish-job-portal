// /account/notices (DD34): see view.tsx. `?after=` is the route's own paging token; the route refuses a changed one (BAD_CURSOR) and the page says so.
import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readNotices } from "../../../lib/data";
import { noticesPath } from "../../../lib/paths";
import { A } from "@portal/ui";
import { Failed, Head } from "../parts";
import { NoticesView, type NoticeRow } from "./view";

export const metadata: Metadata = { title: `Updates | ${SITE_NAME}`, robots: { index: false, follow: false } };

export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const { after } = await searchParams;
  const cursor = typeof after === "string" && after.length <= 200 ? after : undefined; // a longer or repeated one is ignored: the first page
  const read = await readNotices(cursor ? { after: cursor } : undefined);
  if (!read.ok) return <><Head title="Updates" /><Failed what="your updates" code={read.code} />{read.code === "BAD_CURSOR" && <p className="mt-3"><A href={noticesPath()} className="font-semibold underline">Go to the newest updates</A></p>}</>;
  const d = read.data as { items: NoticeRow[]; next: string | null };
  return <NoticesView items={d.items} next={d.next} first={!cursor} />;
}
