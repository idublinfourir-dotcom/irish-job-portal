import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readMe, readRules, readRulesHistory } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { Rules } from "./view";
import { historyKind, isoDay, tabOf } from "./text";

export const metadata: Metadata = { title: `Rules data, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = Record<string, string | string[] | undefined>;
const code = (e: unknown) => (e instanceof Error ? e.message.split(":")[0]! : "");

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const tab = tabOf(one(q.tab)), kind = historyKind(one(q.kind)), after = one(q.after);
  // Any active staff member reads the rules, so there is no wrong-role page: the role only decides which forms and buttons show (a visitor is sent to sign in by guarded).
  const r = await guarded(async () => {
    const [me, rules] = [await readMe(), await readRules()];
    if (tab !== "history") return { me, rules, history: null };
    let h;
    try {
      h = await readRulesHistory({ kind, after });
    } catch (e) {
      if (code(e) !== "bad_cursor") throw e;
      h = await readRulesHistory({ kind }); // a page link that does not read: the first page
    }
    return { me, rules, history: h };
  });
  if (r.refused) return null; // not reached: no role is refused here
  const { me, rules, history } = r.value, now = new Date();
  const base = `/rules?tab=history&kind=${kind}`;
  return (
    <Rules tab={tab} inForce={rules.inForce} upcoming={rules.upcoming} pending={rules.pending} who={{ id: me.id, roles: me.roles }} today={isoDay(now)} now={now}
      history={history ? { kind, items: history.items, next: history.next ? `${base}&after=${encodeURIComponent(history.next)}` : undefined, prev: after ? base : undefined } : undefined} />
  );
}
