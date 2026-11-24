import type { ReactNode } from "react";
import { Icon, Pill } from "@portal/ui";

/**
 * The shared layout of the three staff pages (frames C26 and C27 in staff wording): the form on the left, a dark panel and two cards on the right from 1024 px.
 * The words on the right are placeholders (real copy comes with the content writers). The brand is in the shell, which a visitor does not get, so it is here too.
 */
export function AuthFrame({ title, lead, children }: { title: ReactNode; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-x-20 gap-y-6 py-6 lg:grid-cols-[minmax(0,392px)_minmax(0,1fr)] lg:py-12">
      <div className="flex flex-col justify-center gap-6 lg:min-h-[640px]">
        <Pill tone="lilac" className="w-fit gap-2">
          <Icon name="lock" size={16} />
          Internal, staff only
        </Pill>
        <div className="flex flex-col gap-3">
          <h1 className="lg:text-[32px]">{title}</h1>
          {lead && <p className="text-muted">{lead}</p>}
        </div>
        {children}
      </div>
      <div className="hidden flex-col gap-4 lg:flex" data-aside>
        <div className="flex min-h-[560px] flex-col gap-4 rounded-bento bg-ink p-12 text-white">
          <p className="font-heading text-[46px] font-semibold leading-[1.1] tracking-tight">
            Your queues, <span className="text-mint-on-dark">your roles</span>
          </p>
          <p className="max-w-md text-white/70">Each staff login has its own roles. You see the queues your roles may work, and nothing more.</p>
        </div>
        <div className="grid grid-cols-2 gap-4">
          <p className="rounded-bento bg-peach p-7 font-medium">A staff session ends after 8 hours without use.</p>
          <p className="rounded-bento bg-ink p-7 font-medium text-white">What you change here is written to the audit log.</p>
        </div>
      </div>
    </div>
  );
}
