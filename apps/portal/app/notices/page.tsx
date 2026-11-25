import type { Metadata } from "next";
import { readNotices } from "../../lib/data";
import { anyLogin } from "../_jobs/guard";
import { meta } from "../_site/meta";
import { NoticesView, type NoticeItem } from "./view";

export const metadata: Metadata = meta("Notices", "The notices about your company account and jobs: approvals, jobs hidden, strikes, pay floors and reminders that a job is about to end. Mark them read here.");

const CURSOR = /^[A-Za-z0-9_-]{1,200}$/; // the route's own token alphabet; anything else is not passed on

/** DD34: the signed-in login's notices, newest first, 50 a page. Any login, with or without a company (the bell is the same for both). */
export default async function Page({ searchParams }: { searchParams: Promise<{ after?: string | string[] }> }) {
  const { after } = await searchParams;
  await anyLogin("/notices");
  const token = typeof after === "string" && CURSOR.test(after) ? after : undefined;
  const r = await readNotices(token ? { after: token } : undefined).catch(() => null);
  const b = r?.status === 200 ? r.body : undefined;
  return <NoticesView items={b ? (b.items as NoticeItem[]) : undefined} next={b ? (b.next as string | null) : null} unread={b ? (b.unread as number) : 0} after={token} bad={r?.status === 400} />;
}
