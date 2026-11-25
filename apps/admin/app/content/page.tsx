import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readContentPage, readContentPages, readContentPreview, readMe, readStaleContent } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { Content, href, isTab, type Row } from "./view";
import type { Tab } from "./text";

export const metadata: Metadata = { title: `Content editor, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

const KINDS = ["update", "guide", "help", "occupation"];
type Params = { tab?: string | string[]; id?: string | string[]; after?: string | string[]; preview?: string | string[]; new?: string | string[] };
const idOf = (v: string | undefined) => (v !== undefined && /^[1-9]\d{0,17}$/.test(v) ? v : undefined);

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const rawTab = one(q.tab);
  const tab: Tab = isTab(rawTab) ? rawTab : "update"; // an unknown tab is the first one, not an error page
  const id = idOf(one(q.id));
  const wantPreview = one(q.preview) === "1" && id !== undefined;
  const isNew = one(q.new) === "1" && id === undefined && tab !== "stale";
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    let list: { items: Row[]; next: string | null };
    if (tab === "stale") list = { ...(await readStaleContent()), next: null };
    else {
      try {
        list = await readContentPages({ kind: tab, after });
      } catch (e) {
        if (e instanceof Error && e.message === "bad_cursor") list = await readContentPages({ kind: tab }); // a page link that does not read: the first page
        else throw e;
      }
    }
    const found = id === undefined ? null : await readContentPage(id);
    const page = found && KINDS.includes(found.kind) ? found : null; // a notice is not edited here
    const preview = wantPreview && page ? await readContentPreview(id!) : null;
    return { me, list, page, preview };
  });
  if (r.refused) return <NoAccess title="Content editor" role="content editor or rules data editor" />;
  const { me, list, page, preview } = r.value;
  return (
    <Content tab={tab} items={list.items} selected={page?.id} open={page} preview={preview} isNew={isNew} missingId={id !== undefined && page === null} roles={me.roles} today={new Date().toISOString().slice(0, 10)} now={new Date()}
      next={list.next ? href(tab, { after: list.next }) : undefined} prev={after ? href(tab) : undefined} />
  );
}
