// The legal pages (frame C22, P10): privacy notice, terms of use, cookie policy, employer acceptable use, data retention. One layout, five one-line pages (a folder each, so each has its address).
// Reads only through lib/data.ts (the legal read, R5 and B20). The wording is the placeholder text in the database (Q102): a text whose version or body says so is marked "Draft text" on the
// page, from the data, so the mark leaves when the real text is published. The body is plain text (Q2): the numbered sections and "The short version" box wait for the body format.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { A, Notice, Pill } from "@portal/ui";
import { cachedLegal } from "../../lib/cached";
import { legalPath } from "../../lib/paths";
import { Body } from "./body";
import { dublinDay } from "./dates";
import { wrap } from "./head";
import { meta } from "./meta";
import { Join } from "../jobs/parts";

export const LEGAL_PAGES = [
  { purpose: "signup_terms", title: "Terms of use", about: "The terms you accept when you create an account on Irish Work Permit, and what we ask of you in return." },
  { purpose: "privacy_notice", title: "Privacy notice", about: "What personal data Irish Work Permit collects, why we use it, who sees it, how long we keep it, and your rights over it." },
  { purpose: "cookie_policy", title: "Cookie policy", about: "The cookies Irish Work Permit sets on your device, what each one is for, and how to control them." },
  { purpose: "employer_acceptable_use", title: "Acceptable use for employers", about: "The rules every employer and agency agrees to when posting jobs on Irish Work Permit, and what happens when they are broken." },
  { purpose: "data_retention", title: "Data retention", about: "How long Irish Work Permit keeps each kind of personal data, and when it is deleted." },
] as const;
export type Purpose = (typeof LEGAL_PAGES)[number]["purpose"];

export type LegalText = { purpose: string; version: string; body: string; publishedAt: string };
/** A text the owner has not replaced yet: its version or its body says "placeholder" or "draft". */
export const isDraft = (t: Pick<LegalText, "version" | "body">) => /placeholder|draft/i.test(t.version) || /^\s*(placeholder|draft)\b/i.test(t.body);
/** The day of a database time ("2026-11-19 09:30:00.123456+00") on the Irish calendar, written out; null when it is not a time. */
export const publishedDay = (s: string) => dublinDay(s.replace(" ", "T").replace(/\+00$/, "Z").replace(/(\.\d{3})\d+/, "$1"));

export const legalMeta = (purpose: Purpose): Metadata => {
  const p = LEGAL_PAGES.find((x) => x.purpose === purpose)!;
  return meta(p.title, p.about, legalPath(purpose)!);
};

function Side({ current }: { current: Purpose }) {
  return (
    <nav aria-label="Legal documents" className="flex flex-col gap-1 rounded-bento bg-sand p-4 lg:p-5">
      <p className="px-3 py-2 text-small font-semibold">Legal</p>
      {LEGAL_PAGES.map((p) => (
        <A key={p.purpose} href={legalPath(p.purpose)!} aria-current={p.purpose === current ? "page" : undefined} className={`flex min-h-11 items-center rounded-pill px-4 text-ui no-underline ${p.purpose === current ? "bg-deep-green font-semibold text-white" : "text-muted hover:bg-hover-light"}`}>{p.title}</A>
      ))}
    </nav>
  );
}

export function LegalView({ purpose, text, signedIn }: { purpose: Purpose; text: LegalText | null; signedIn: boolean }): ReactNode {
  const page = LEGAL_PAGES.find((p) => p.purpose === purpose)!;
  const day = text ? publishedDay(text.publishedAt) : null;
  return (
    <>
      <div className={`${wrap} pb-12 pt-6 sm:pt-8`}>
        <div className="grid items-start gap-6 lg:grid-cols-[17.5rem_minmax(0,1fr)] lg:gap-10">
          <aside className="lg:sticky lg:top-6"><Side current={purpose} /></aside>
          <article className="min-w-0 max-w-[47.5rem]">
            <h1 className="break-words">{page.title}</h1>
            {text && (
              <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-small text-muted">
                {isDraft(text) && <Pill tone="peach" className="min-h-0 px-3 py-[3px] text-[13px] font-semibold">Draft text, not final</Pill>}
                <span>Version {text.version}</span>
                {day && <span>Published {day}</span>}
              </p>
            )}
            {text ? <Body text={text.body} className="mt-6 text-body" /> : <div className="mt-6"><Notice kind="info" title="Not published yet">This text has not been published yet. If you need it now, send us a message from the <A href="/help" className="underline underline-offset-2">help page</A>.</Notice></div>}
          </article>
        </div>
      </div>
      {!signedIn && <Join />}
    </>
  );
}

/** A legal page: the text in force, read by the cached loader (Stage 3 step 5: cached a day, cleared when a legal text is confirmed). A missing text is
 *  "not published yet"; a failed read throws, so a regeneration keeps the last good copy. The Join band is the visitor's, hidden by the hint switch. */
export async function LegalPage({ purpose }: { purpose: Purpose }): Promise<ReactNode> {
  const text = (await cachedLegal(purpose)) as LegalText | null;
  return <LegalView purpose={purpose} text={text} signedIn={false} />;
}
