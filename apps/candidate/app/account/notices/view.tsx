// The updates page (DD34, bell link of the header): the candidate's in-app updates, newest first, 50 a page. #287 (Q54): no "N updates since" count; the page counts the unseen
// rows it was given. The wording is ours (messages.ts); a notice's params are never printed.
import { A, EmptyState, Icon, cx } from "@portal/ui";
import { applicationsPath, casesPath, noticesPath, profilePath } from "../../../lib/paths";
import { MarkSeen } from "../client";
import { noticeText } from "../messages";
import { Head } from "../parts";

export type NoticeRow = { id: string; category: string; templateKey: string; createdAt: string; readAt: string | null };
/** Where a notice leads, by its key; none for one with nowhere to go. */
const LEADS: Record<string, string> = { case_update: casesPath(), application_moved: applicationsPath(), account_merged: profilePath() };
const day = (iso: string) => new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Dublin" }).format(new Date(iso));

export function NoticesView({ items, next, first }: { items: NoticeRow[]; next: string | null; first: boolean }) {
  const unseen = items.filter((i) => !i.readAt).length;
  return (
    <>
      <Head title="Updates" line={items.length ? (unseen ? `${unseen} unseen on this page.` : "You have seen everything on this page.") : undefined} action={unseen > 0 && <MarkSeen />} />
      {items.length === 0 ? (
        <EmptyState icon="bell" title="No updates yet">When something changes on your account or a case, it shows here.</EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((n) => {
            const t = noticeText(n.templateKey);
            const lead = LEADS[n.templateKey];
            return (
              <li key={n.id} data-notice-id={n.id} data-unseen={!n.readAt} className={cx("flex flex-wrap items-start gap-x-4 gap-y-2 rounded-bento p-4 sm:p-5", n.readAt ? "bg-sand" : "bg-lilac")}>
                <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-pill bg-white text-deep-green"><Icon name="bell" size={18} /></span>
                <div className="min-w-0 flex-1 basis-56">
                  <h2 className="text-[17px] leading-snug">{t.title}</h2>
                  <p className="text-small">{t.line}</p>
                  <p className="mt-1 text-small text-muted">{day(n.createdAt)}{!n.readAt && " · New"}</p>
                  {lead && <p className="mt-2"><A href={lead} className="font-semibold text-deep-green underline underline-offset-2">Open</A></p>}
                </div>
                {!n.readAt && <MarkSeen id={n.id} />}
              </li>
            );
          })}
        </ul>
      )}
      <p className="mt-5 flex gap-4">
        {!first && <A href={noticesPath()} className="font-semibold underline underline-offset-2">Newest updates</A>}
        {next && <A href={`${noticesPath()}?after=${encodeURIComponent(next)}`} className="font-semibold underline underline-offset-2">Older updates</A>}
      </p>
    </>
  );
}
