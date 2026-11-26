// The body of a guide, help page, update, occupation text or legal text, in the body format of B16 (#303, limited Markdown, `parseBody` in
// packages/db/src/body-format.ts). ONE component for every body. Never HTML: the parser returns data, React escapes every text, and there is no
// dangerouslySetInnerHTML anywhere; a link the format does not allow arrives as plain text.
import { Fragment } from "react";
import { A } from "@portal/ui";
import { firstParagraph, parseBody, type Line } from "@portal/db";

/** The first paragraph as plain text, for a page's description. */
export { firstParagraph };

function Text({ line }: { line: Line }) {
  return line.map((p, i) =>
    p.href ? (
      <A key={i} href={p.href} className="font-semibold text-deep-green underline underline-offset-2" {...(p.href.startsWith("https://") ? { rel: "noopener noreferrer" } : {})}>{p.text}</A>
    ) : p.bold ? <strong key={i} className="font-semibold text-ink">{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>,
  );
}
const Lines = ({ lines }: { lines: Line[] }) => lines.map((l, i) => <Fragment key={i}>{i > 0 && <br />}<Text line={l} /></Fragment>);

/** `toc`: an "On this page" list of the section headings, when there are two or more (guides). */
export function Body({ text, className = "", toc = false }: { text: string; className?: string; toc?: boolean }) {
  const blocks = parseBody(text);
  const sections = blocks.flatMap((b) => (b.kind === "h2" ? [b] : []));
  return (
    <div data-body className={`flex flex-col gap-4 ${className}`}>
      {toc && sections.length >= 2 && (
        <nav aria-label="On this page" className="rounded-bento border border-line p-5">
          <p className="font-semibold text-ink">On this page</p>
          <ul className="mt-2 flex flex-col gap-1.5">{sections.map((s) => <li key={s.id}><A href={`#${s.id}`} className="text-deep-green underline-offset-2 hover:underline">{s.text}</A></li>)}</ul>
        </nav>
      )}
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "h2": return <h2 key={i} id={b.id} className="mt-4 scroll-mt-6 text-[1.375rem] text-ink">{b.text}</h2>;
          case "h3": return <h3 key={i} id={b.id} className="mt-2 scroll-mt-6 text-[1.125rem] text-ink">{b.text}</h3>;
          case "ul": return <ul key={i} className="flex list-disc flex-col gap-1.5 pl-6">{b.items.map((l, j) => <li key={j}><Text line={l} /></li>)}</ul>;
          case "ol": return <ol key={i} className="flex list-decimal flex-col gap-1.5 pl-6">{b.items.map((l, j) => <li key={j}><Text line={l} /></li>)}</ol>;
          case "callout": return <div key={i} role="note" className="rounded-bento border-l-4 border-deep-green bg-pale-green px-5 py-4 text-ink"><Lines lines={b.lines} /></div>;
          case "table":
            return (
              <div key={i} className="overflow-x-auto">
                <table className="w-full text-left text-ui">
                  <thead><tr className="border-b border-line">{b.head.map((c, j) => <th key={j} scope="col" className="px-3 py-2 font-semibold text-ink"><Text line={c} /></th>)}</tr></thead>
                  <tbody>{b.rows.map((r, j) => <tr key={j} className="border-b border-line">{r.map((c, k) => <td key={k} className="px-3 py-2"><Text line={c} /></td>)}</tr>)}</tbody>
                </table>
              </div>
            );
          default: return <p key={i} className="break-words"><Lines lines={b.lines} /></p>;
        }
      })}
    </div>
  );
}
