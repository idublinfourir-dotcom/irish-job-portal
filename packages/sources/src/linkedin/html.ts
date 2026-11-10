// `strip` from prototype/fetch_linkedin_lib.py:24-27. It is not the ATS `text`: it does not squeeze blank lines.
// The tag scan is the one in ../ats/shared.ts (replaceTags, not exported there). Python's two tag patterns are quadratic on a
// body of "<<<<..." with no ">", so they are replaced by a one-pass scan with the same result.
// ponytail: copy of ats/shared.ts replaceTags. Delete it when that function is exported.
import { htmlUnescape, pyStrip } from "../ats/shared";

const BREAK_TAG = /(?:br|\/p|\/l[iı]|\/h\p{Nd}|\/d[iı]v)/iuy; // <(br|/p|/li|/h\d|/div)  ([iı]: Python's re.I folds dotless i)

function replaceTags(h: string, replacement: string, prefix: RegExp | null): string {
  let out = "";
  let from = 0;
  let i = h.indexOf("<");
  while (i >= 0) {
    let bodyStart = i + 1;
    if (prefix) {
      prefix.lastIndex = i + 1;
      if (!prefix.test(h)) {
        i = h.indexOf("<", i + 1);
        continue;
      }
      bodyStart = prefix.lastIndex;
    }
    const gt = h.indexOf(">", bodyStart);
    if (gt < 0) break; // no ">" left: no later "<" can match
    if (!prefix && gt === i + 1) {
      i = h.indexOf("<", i + 1);
      continue;
    }
    out += h.slice(from, i) + replacement;
    from = gt + 1;
    i = h.indexOf("<", from);
  }
  return out + h.slice(from);
}

export function strip(h: string): string {
  let t = replaceTags(htmlUnescape(h), "\n", BREAK_TAG);
  t = replaceTags(t, " ", null);
  return pyStrip(t.replace(/[ \t]+/g, " "));
}
