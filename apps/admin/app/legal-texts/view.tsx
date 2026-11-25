// The legal texts page (two-person editor, a plain text box until Q2) as parts that take their data as props. The bodies are plain text, shown escaped in a <pre>.
import { Notice } from "@portal/ui";
import { when } from "../_tools/text";
import { Controls } from "./controls";
import { PURPOSES } from "./text";

export type Version = { id: string; purpose: string; version: string; body: string; publishedAt: string };
export type Proposal = { requestId: string; purpose: string; version: string; body: string; proposedBy: string; createdAt: string };

const Body = ({ children }: { children: string }) => <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-control bg-white p-4 text-small [overflow-wrap:anywhere]">{children}</pre>;

export function LegalTexts({ versions, pending, meId, roles }: { versions: Version[]; pending: Proposal[]; meId: string; roles: string[] }) {
  const isAdmin = roles.includes("administrator"), canPropose = roles.includes("content_editor");
  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="mb-1 text-[32px] leading-tight md:text-[34px]">Legal texts</h1>
        <p className="text-muted">The terms and notices people agree to. A content editor proposes a new version; a different administrator publishes it. The real wording waits for the solicitor, so today these are placeholders.</p>
      </header>
      {versions.length === 0 && pending.length === 0 && <Notice kind="info">No legal text has been published yet.</Notice>}
      {PURPOSES.map(([purpose, label]) => {
        const mine = versions.filter((v) => v.purpose === purpose); // newest first: the first is the text in force
        const live = mine[0];
        const p = pending.find((x) => x.purpose === purpose);
        return (
          <section key={purpose} aria-label={label} className="flex flex-col gap-3 rounded-bento bg-sand p-5">
            <h2 className="text-[22px]">{label}</h2>
            {live ? (
              <details>
                <summary className="min-h-11 cursor-pointer py-2.5 font-semibold text-deep-green">{`In force: version ${live.version}, published ${when(live.publishedAt)}`}</summary>
                <Body>{live.body}</Body>
              </details>
            ) : (
              <p className="text-muted">Nothing is published for this text yet.</p>
            )}
            {mine.length > 1 && <p className="text-small text-muted">{`Earlier versions: ${mine.slice(1).map((v) => v.version).join(", ")}.`}</p>}
            {p && (
              <details open>
                <summary className="min-h-11 cursor-pointer py-2.5 font-semibold">{`Proposed: version ${p.version}, ${when(p.createdAt)}`}</summary>
                <Body>{p.body}</Body>
              </details>
            )}
            <Controls purpose={purpose} label={label} isAdmin={isAdmin} canPropose={canPropose} pending={p && { requestId: p.requestId, version: p.version, mine: p.proposedBy === meId }} />
          </section>
        );
      })}
    </div>
  );
}
