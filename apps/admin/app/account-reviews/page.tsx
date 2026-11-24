import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readAccountReview, readAccountReviews, readMe } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { AccountReviews, href, isTab, type Tab } from "./view";

export const metadata: Metadata = { title: `Account reviews, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { tab?: string | string[]; id?: string | string[]; after?: string | string[] };

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const rawTab = one(q.tab);
  const tab: Tab = isTab(rawTab) ? rawTab : "waiting"; // an unknown tab is the first one, not an error page
  const id = one(q.id);
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    const read = async (cursor?: string) => readAccountReviews({ tab, after: cursor });
    let list;
    try {
      list = await read(after);
    } catch (e) {
      if (e instanceof Error && e.message === "bad_cursor") list = await read(); // a page link that does not read: the first page
      else throw e;
    }
    // the open item is the one asked for (from the list when it is on this page, else read on its own), or the first row
    const selected = id === undefined ? (list.items[0] ?? null) : (list.items.find((i) => i.id === id) ?? (await readAccountReview(id)));
    const missingId = id !== undefined && selected === null;
    return { me, list, selected, missingId };
  });
  if (r.refused) return <NoAccess title="Account reviews" role="account reviewer" />;
  const { me, list, selected, missingId } = r.value;
  return <AccountReviews tab={tab} items={list.items} counts={list.counts} selected={selected} missingId={missingId} meId={me.id} now={new Date()} next={list.next ? href(tab, undefined, list.next) : undefined} prev={after ? href(tab) : undefined} />;
}
