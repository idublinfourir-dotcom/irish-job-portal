import type { Metadata } from "next";
import { SITE_NAME } from "@portal/ui";
import { readBans, readWrcReported } from "../../lib/data";
import { guarded, one } from "../_queue/guard";
import { NoAccess } from "../_queue/no-access";
import { BanList, type Ban, type Wrc } from "./view";

export const metadata: Metadata = { title: `Ban list, ${SITE_NAME} admin`, robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

type Params = { after?: string | string[]; wrc?: string | string[] };
const link = (after?: string, wrc?: string) => `/ban-list${(s => (s ? `?${s}` : ""))(new URLSearchParams({ ...(after ? { after } : {}), ...(wrc ? { wrc } : {}) }).toString())}`;

/** A list read; a page link that does not read (bad_cursor) shows the first page and says so. */
async function page<T>(read: (o: { after?: string }) => Promise<T>, after: string | undefined): Promise<{ list: T; bad: boolean }> {
  try {
    return { list: await read({ after }), bad: false };
  } catch (e) {
    if (after !== undefined && e instanceof Error && e.message.startsWith("bad_cursor")) return { list: await read({}), bad: true };
    throw e;
  }
}

export default async function Page({ searchParams }: { searchParams: Promise<Params> }) {
  const q = await searchParams;
  const after = one(q.after), wrcAfter = one(q.wrc);
  const r = await guarded(async () => ({ bans: await page(readBans, after), wrc: await page(readWrcReported, wrcAfter) }));
  if (r.refused) return <NoAccess title="Ban list" role="trust and safety" />;
  const { bans, wrc } = r.value;
  return (
    <BanList
      bans={{ items: bans.list.items as unknown as Ban[], next: bans.list.next ? link(bans.list.next, wrcAfter) : undefined, prev: after && !bans.bad ? link(undefined, wrcAfter) : undefined }}
      wrc={{ items: wrc.list.items as unknown as Wrc[], next: wrc.list.next ? link(after, wrc.list.next) : undefined, prev: wrcAfter && !wrc.bad ? link(after) : undefined }}
      missing={bans.bad || wrc.bad}
    />
  );
}
