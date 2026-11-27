// B16 (#303): the body format of guides, help pages, updates, occupation texts and legal texts, a limited Markdown: paragraphs, "## " and "### " headings,
// "- " and "1. " lists, tables, "> " callouts, **bold** and links to https or a path on the site. One parser for both sides: staff saving a body
// (`bodyProblem`) and the candidate site showing it (`parseBody`). It returns data, never HTML, so the page renders it with React's escaping and
// nothing in a body can become markup; a link it does not allow is shown as its plain text.

export type Inline = { text: string; bold?: true; href?: string };
export type Line = Inline[];
export type Block =
  | { kind: "p" | "callout"; lines: Line[] }
  | { kind: "h2" | "h3"; text: string; id: string }
  | { kind: "ul" | "ol"; items: Line[] }
  | { kind: "table"; head: Line[]; rows: Line[][] };

/** https, or a path on this site ("/x", never "//host"). No backslash anywhere, plain or as %5C (SEC-17): browsers read "/\host"
 *  as "//host", another site, and a later path cleanup can decode %5C into one (the rule of ownPath in packages/auth/src/reauth.ts). */
export const allowedHref = (h: string) => !/\\|%5c/i.test(h) && (/^https:\/\/[^\s/?#][^\s]*$/.test(h) || /^\/(?!\/)[^\s]*$/.test(h));

// [text](href) or **bold**; neither crosses a line. Linear: no run can hold the character that starts another match ("[" in a link's text, brackets and
// parentheses in its address, "*" in bold), so a failed try never rescans the rest of the text (50,000 "[" took 8 s before; the test keeps it under 200 ms).
// ponytail: an address with brackets or parentheses is not a link (shown as text); percent-encode them if a source ever needs one.
const INLINE = /\[([^[\]\n]+)\]\(([^()[\]\s]+)\)|\*\*([^*\n]+)\*\*/g;
export function parseInline(s: string): Line {
  const out: Line = [];
  let at = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > at) out.push({ text: s.slice(at, m.index) });
    if (m[3] !== undefined) out.push({ text: m[3], bold: true });
    else out.push(allowedHref(m[2]!) ? { text: m[1]!, href: m[2]! } : { text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < s.length) out.push({ text: s.slice(at) });
  return out;
}

const ROW = /^\|.*\|\s*$/;
const RULE = /^\|(\s*:?-{3,}:?\s*\|)+\s*$/;
const cells = (row: string) => row.trim().slice(1, -1).split("|").map((c) => parseInline(c.trim()));
const slug = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "section";

/** The blocks of a body, line by line. Never throws; what breaks a rule (see `bodyProblem`) is shown as plain text. */
export function parseBody(text: string): Block[] {
  const blocks: Block[] = [];
  const ids = new Map<string, number>();
  let table: string[] = [];
  const flushTable = () => {
    if (!table.length) return;
    const [head, rule, ...rows] = table;
    if (rule !== undefined && RULE.test(rule)) blocks.push({ kind: "table", head: cells(head!), rows: rows.map(cells) });
    else blocks.push({ kind: "p", lines: table.map(parseInline) });
    table = [];
  };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (ROW.test(line)) {
      table.push(line);
      continue;
    }
    flushTable();
    const last = blocks.at(-1);
    let m: RegExpExecArray | null;
    if (line.trim() === "") blocks.push({ kind: "p", lines: [] }); // a break: the next line starts a new block
    else if ((m = /^(#{2,3}) (.+)$/.exec(line))) {
      const t = m[2]!.trim(), base = slug(t), n = (ids.get(base) ?? 0) + 1;
      ids.set(base, n);
      blocks.push({ kind: m[1] === "##" ? "h2" : "h3", text: t, id: n === 1 ? base : `${base}-${n}` });
    } else if ((m = /^(- |\d{1,3}\. )(.*)$/.exec(line))) {
      const kind = m[1] === "- " ? "ul" : "ol";
      if (last?.kind === kind) last.items.push(parseInline(m[2]!));
      else blocks.push({ kind, items: [parseInline(m[2]!)] });
    } else if ((m = /^> ?(.*)$/.exec(line))) {
      if (last?.kind === "callout") last.lines.push(parseInline(m[1]!));
      else blocks.push({ kind: "callout", lines: [parseInline(m[1]!)] });
    } else if (last?.kind === "p" && last.lines.length) last.lines.push(parseInline(line.trim()));
    else blocks.push({ kind: "p", lines: [parseInline(line.trim())] });
  }
  flushTable();
  return blocks.filter((b) => b.kind !== "p" || b.lines.length > 0);
}

/** Why a body cannot be saved, or null. The reasons staff read: the page shows a refused piece as plain text, so it is refused before it is saved. */
export function bodyProblem(text: string): "html" | "heading_1" | "link" | "table" | null {
  if (/<[A-Za-z/!?]/.test(text)) return "html";
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trimEnd());
  if (lines.some((l) => /^# /.test(l))) return "heading_1";
  for (const m of text.matchAll(INLINE)) if (m[2] !== undefined && !allowedHref(m[2])) return "link";
  if (/\]\((?!https:\/\/|\/(?!\/))/.test(text)) return "link"; // also one INLINE does not read (an address with brackets, javascript:alert(1))
  for (let i = 0; i < lines.length; i++) {
    if (!ROW.test(lines[i]!) || (i > 0 && ROW.test(lines[i - 1]!))) continue; // the first row of a table
    let end = i;
    while (end + 1 < lines.length && ROW.test(lines[end + 1]!)) end++;
    const width = cells(lines[i]!).length;
    if (end === i || !RULE.test(lines[i + 1]!) || lines.slice(i, end + 1).some((r) => cells(r).length !== width)) return "table";
    i = end;
  }
  return null;
}

/** The first paragraph as plain text (a page's description), or undefined. */
export const firstParagraph = (text: string) => {
  const p = parseBody(text).find((b) => b.kind === "p");
  return p?.kind === "p" ? p.lines.map((l) => l.map((i) => i.text).join("")).join(" ") : undefined;
};
