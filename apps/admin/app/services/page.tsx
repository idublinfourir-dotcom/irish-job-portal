import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readServiceCases } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { STATUSES, isStatus, type Row, type Status } from "./text";
import { Services, href, isWho, type View } from "./view";

export const metadata: Metadata = { title: `Services cases, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { view?: string | string[]; status?: string | string[]; who?: string | string[]; after?: string | string[] };
type Page = { items: Row[]; next: string | null };

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const view: View = one(q.view) === "table" ? "table" : "board"; // an unknown value is the board, not an error page
  const rawStatus = one(q.status);
  const status: Status = isStatus(rawStatus) ? rawStatus : "received";
  const rawWho = one(q.who);
  const who = isWho(rawWho) ? rawWho : "all";
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    if (view === "board") {
      const pages = (await Promise.all(STATUSES.map((s) => readServiceCases({ status: s })))) as Page[];
      return { me, columns: STATUSES.map((s, i) => ({ status: s, rows: pages[i]!.items, more: pages[i]!.next !== null })), list: null };
    }
    const read = async (cursor?: string) => (await readServiceCases({ status, after: cursor })) as Page;
    let list: Page;
    try {
      list = await read(after);
    } catch (e) {
      if (e instanceof Error && e.message === "bad_cursor") list = await read(); // a page link that does not read: the first page
      else throw e;
    }
    return { me, columns: undefined, list };
  });
  if (r.refused) return <NoAccess title="Services cases" role="services case handler or administrator" />;
  const { me, columns, list } = r.value;
  return <Services view={view} status={status} who={who} me={me.id} now={new Date()} columns={columns ?? undefined} rows={list?.items} next={list?.next ? href({ view, status, who, after: list.next }) : undefined} prev={after ? href({ view, status, who }) : undefined} />;
}
