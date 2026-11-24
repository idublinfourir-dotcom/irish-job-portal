import type { ReactNode } from "react";
import { Icon } from "@portal/ui";
import { LegalLine, Page } from "../_site/chrome";

/** The four steps of sign-up, account first (decision #287): the account type, the account, the company, the review. */
export const STEPS = ["Account type", "Your account", "Company", "Review"] as const;

/** The progress pills of frames E02 to E06: finished ones tick, the current one is dark. */
export function Steps({ at }: { at: 1 | 2 | 3 | 4 }) {
  return (
    <ol aria-label="Sign-up steps" className="flex flex-wrap gap-1.5 lg:w-[30rem] lg:flex-nowrap">
      {STEPS.map((label, i) => {
        const n = i + 1, state = n < at ? "done" : n === at ? "now" : "todo";
        return (
          <li key={label} aria-current={state === "now" ? "step" : undefined}
            className={`inline-flex min-h-[30px] items-center gap-1.5 rounded-pill px-2.5 text-small font-medium ${state === "now" ? "bg-ink text-white" : state === "done" ? "bg-green-tint text-ink" : "bg-lilac text-ink"}`}>
            {state === "done" ? <Icon name="check" size={14} /> : `${n}. `}{label}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The two-column frame of the sign-up, sign-in and verification pages (frames E02 to E06, and C26 and C27 in employer wording): the form on the left, a dark panel and two cards
 * on the right from 1024 px. `panel` is the two-tone line of the dark panel (the second part is green), `panelLead` the words under it.
 */
export function AuthFrame({ step, title, lead, icon, panel, panelLead, candidates, help, bare, children }: {
  step?: 1 | 2 | 3 | 4; bare?: boolean; title: ReactNode; lead?: ReactNode; icon?: ReactNode; panel: [string, string]; panelLead: ReactNode; candidates?: string | null; help?: string | null; children: ReactNode;
}) {
  const body = (
      <div className="grid gap-x-16 gap-y-6 py-6 lg:grid-cols-[minmax(0,392px)_minmax(0,1fr)] lg:py-8">
        <div className="flex flex-col justify-center gap-6">
          {step && <Steps at={step} />}
          {icon}
          <div className="flex flex-col gap-3">
            <h1 className="lg:text-[32px]">{title}</h1>
            {lead && <p className="text-muted">{lead}</p>}
          </div>
          {children}
          <LegalLine help={help} />
        </div>
        <div className="hidden flex-col gap-4 lg:flex" data-aside>
          <div className="flex min-h-[560px] flex-col gap-4 rounded-bento bg-ink p-12 text-white">
            <p className="max-w-md font-heading text-[46px] font-semibold leading-[1.1] tracking-tight">{panel[0]} <span className="block text-mint-on-dark">{panel[1]}</span></p>
            <p className="max-w-md text-white/70">{panelLead}</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <p className="rounded-bento bg-peach p-7 font-medium"><strong>Free to post.</strong> Jobs stay live for a set time, and you renew them in one click.</p>
            <p className="rounded-bento bg-ink p-7 font-medium text-white">Asking candidates for money is an instant ban.</p>
          </div>
        </div>
      </div>
  );
  return bare ? body : <Page candidates={candidates}>{body}</Page>;
}
