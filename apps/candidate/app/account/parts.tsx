// Small server parts the account pages share.
import type { ReactNode } from "react";
import { Notice } from "@portal/ui";
import { wording } from "./messages";

/** The page title block of the account pages: one H1 and the line under it. */
/** `big`: the greeting of the home page (frame NA1 sets it at about 64 px); the other pages use the page-title size. */
export const Head = ({ title, line, action, big }: { title: ReactNode; line?: ReactNode; action?: ReactNode; big?: boolean }) => (
  <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
    <div className="min-w-0">
      <h1 className={big ? "text-[2.4rem] leading-[1.25] sm:text-[3.5rem] xl:text-[4rem]" : "text-[2rem] leading-tight sm:text-[2.4rem]"}>{title}</h1>
      {line && <p className="mt-1 text-muted">{line}</p>}
    </div>
    {action}
  </div>
);

/** A read that failed: the page keeps its frame and says so (the code is the route's, the words are ours). */
export const Failed = ({ what, code }: { what: string; code?: string }) => <Notice kind="error" title={`We could not load ${what}`}>{wording(code ?? "READ_FAILED")}</Notice>;

