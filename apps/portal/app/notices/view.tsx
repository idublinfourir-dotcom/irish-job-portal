// DD34: the notice list (the bell's page). Words by template key (words.ts); an unknown key reads as a general notice. Previous goes back to the newest page (the route's
// cursor only goes forward), Next to the next 50.
import { Button, EmptyState, Notice, Pager } from "@portal/ui";
import { MarkRead } from "./marks";
import { noticeWord } from "../_jobs/words";

export type NoticeItem = { id: string; category: string; templateKey: string; createdAt: string; readAt: string | null };
const WHEN = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Europe/Dublin" });
const when = (iso: string) => { const d = new Date(iso); return Number.isNaN(+d) ? "" : WHEN.format(d); };

export function NoticesView({ items, next, unread, after, bad }: { items?: NoticeItem[]; next: string | null; unread: number; after?: string; bad?: boolean }) {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div><h1>Notices</h1><p className="mt-2 text-muted" data-unread-line>{unread === 0 ? "Nothing unread." : `${unread >= 200 ? "200 or more" : unread} unread.`}</p></div>
        {unread > 0 && <MarkRead all />}
      </header>
      {bad ? (
        <Notice kind="warning" title="That page of notices is not available">Go back to the newest notices.<span className="mt-3 block"><Button href="/notices" variant="dark" size="sm">Newest notices</Button></span></Notice>
      ) : !items ? (
        <Notice kind="error" title="We cannot show your notices now">Reload the page in a minute.</Notice>
      ) : items.length === 0 ? (
        <EmptyState icon="bell" title="No notices yet">When something changes on your account or jobs, it shows here.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((n) => {
            const [title, text] = noticeWord(n.templateKey);
            return (
              <li key={n.id} data-notice-id={n.id} data-unread={n.readAt ? undefined : ""} className={`flex flex-wrap items-center justify-between gap-3 rounded-card p-4 ${n.readAt ? "bg-sand" : "border-2 border-deep-green bg-white"}`}>
                <span><span className="block font-semibold">{n.readAt ? "" : <span className="mr-2 inline-block size-2.5 rounded-pill bg-deep-green" aria-label="Unread" role="img" />}{title}</span><span className="block text-muted">{text}</span><span className="text-small text-muted">{when(n.createdAt)}</span></span>
                {!n.readAt && <MarkRead id={n.id} />}
              </li>
            );
          })}
        </ul>
      )}
      {!bad && items && (after || next) && <Pager prevHref={after ? "/notices" : undefined} nextHref={next ? `/notices?after=${encodeURIComponent(next)}` : undefined} />}
    </div>
  );
}
