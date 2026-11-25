import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readReport, readStrikeCase, readTrustList } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { href, isTab, parseLabel, type CaseItem, type Counts, type ReportItem, type Row, type Tab } from "./text";
import { Reports, type Selected } from "./view";

export const metadata: Metadata = { title: `Reports and strikes, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { tab?: string | string[]; id?: string | string[]; after?: string | string[] };
const label = (kind: "report" | "case", id: string) => `${kind === "report" ? "R" : "C"}-${id.padStart(4, "0")}`;

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const rawTab = one(q.tab);
  const tab: Tab = isTab(rawTab) ? rawTab : "open"; // an unknown tab is the first one, not an error page
  const after = one(q.after);
  const r = await guarded(async () => {
    const me = await readMe();
    const read = (cursor?: string) => readTrustList({ tab, after: cursor });
    let list;
    try {
      list = await read(after);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("bad_cursor")) list = await read(); // a page link that does not read: the first page
      else throw e;
    }
    const items = list.items as unknown as Row[];
    // the open panel is the one asked for (a label like R-0091; anything else is ignored), else the first row
    const asked = parseLabel(one(q.id));
    const pick = asked ?? (items[0] ? { kind: items[0].kind, id: items[0].id } : null);
    let selected: Selected | null = null;
    if (pick?.kind === "report") {
      const item = (await readReport(pick.id)) as unknown as ReportItem | null;
      if (item) selected = { kind: "report", item, label: label("report", pick.id) };
    } else if (pick) {
      const item = (await readStrikeCase(pick.id)) as unknown as CaseItem | null;
      if (item) selected = { kind: "case", item, label: label("case", pick.id), reportLabel: item.reportId ? label("report", item.reportId) : undefined };
    }
    return { me, list, items, selected, missingId: one(q.id) !== undefined && selected === null };
  });
  if (r.refused) return <NoAccess title="Reports and strikes" role="trust and safety" />;
  const { me, list, items, selected, missingId } = r.value;
  return <Reports tab={tab} items={items} counts={list.counts as Counts | null} selected={selected} missingId={missingId} meId={me.id} now={new Date()} next={list.next ? href(tab, undefined, list.next) : undefined} prev={after ? href(tab) : undefined} />;
}
