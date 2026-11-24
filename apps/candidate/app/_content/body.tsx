// The body of a guide, help page, update or legal text (Q2, the body format, is open): today it is plain text, shown as paragraphs, nothing else.
// ONE component, so when the format is decided (headings, tables, callouts, "On this page") this is the only file that changes. Never HTML:
// React escapes the text, and there is no dangerouslySetInnerHTML anywhere.
export const paragraphs = (text: string) => text.replace(/\r\n?/g, "\n").split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

export function Body({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div data-body className={`flex flex-col gap-4 ${className}`}>
      {paragraphs(text).map((p, i) => (
        <p key={i} className="whitespace-pre-line break-words">{p}</p>
      ))}
    </div>
  );
}
