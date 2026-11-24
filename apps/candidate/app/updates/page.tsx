// /updates: the government updates feed (P10, frame C17), newest first, 20 a page, with the update type as a filter. Reads only through lib/data.ts. Previous and Next only (#125): the read
// gives a `next` cursor, so the address carries the cursors of the pages already passed (_content/trail.ts).
import type { Metadata } from "next";
import { readSignedIn, readUpdates } from "../../lib/data";
import { staticPath } from "../../lib/paths";
import { meta } from "../_content/meta";
import { Problem, type Failed } from "../_content/problem";
import { cursorOf, pagerLinks, parseTrail } from "../_content/trail";
import { UpdatesView, knownCategory, type UpdateData } from "./updates-view";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const sp = await searchParams;
  const filtered = knownCategory(sp.category) !== undefined || cursorOf(sp.after) !== undefined;
  return meta("Government updates", "Quota notices, salary minimum changes, occupation list changes and processing news for Irish employment permits, entered by our team from DETE's notices.", staticPath("updates")!, filtered);
}

export default async function Page({ searchParams }: Props) {
  const sp = await searchParams;
  const category = knownCategory(sp.category);
  const after = cursorOf(sp.after);
  const q = new URLSearchParams({ ...(category ? { category } : {}), ...(after ? { after } : {}) });
  const [r, signedIn] = await Promise.all([readUpdates(q), readSignedIn()]);
  if (!r.ok) return <Problem read={r as Failed} what="updates" back={{ href: staticPath("updates")!, label: "Open the updates" }} />;
  const { updates, next } = r.data as { updates: UpdateData[]; next: string | null };
  const links = pagerLinks({ base: staticPath("updates")!, keep: category ? { category } : undefined, after, back: parseTrail(sp.back), next });
  return <UpdatesView updates={updates} category={category} signedIn={signedIn} {...links} />;
}
